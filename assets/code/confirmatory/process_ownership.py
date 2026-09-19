"""Exclusive, cooperative Linux worker ownership across PID namespaces.

The host must reserve child creation for one supervisor until close. Subreaping
retains descendants that change session or outlive their immediate parent.
Signals use checked pidfds; procfs PID numbers are never used as signal targets.
Sampling is observational and may miss a transient RSS peak.
"""
from __future__ import annotations

import ctypes
import os
from pathlib import Path
import resource
import select
import signal
import sys
import time


def namespace_pids(text):
    rows = [line.split()[1:] for line in text.splitlines() if line.startswith('NSpid:')]
    if len(rows) != 1 or not rows[0]:
        raise OSError('one nonempty NSpid mapping required')
    values = [int(value) for value in rows[0]]
    if any(value <= 0 for value in values):
        raise OSError('invalid namespace PID')
    return values


def stat_info(text):
    fields = text.rsplit(')', 1)[1].split()
    result = {'parent': int(fields[1]), 'start_ticks': int(fields[19]),
              'cpu_ticks': sum(int(fields[i]) for i in (11, 12, 13, 14)),
              'state': fields[0]}
    if any(result[key] < 0 for key in ('parent', 'start_ticks', 'cpu_ticks')):
        raise OSError('negative process counter')
    return result


def process_table():
    table = {}
    for path in Path('/proc').iterdir():
        if path.name.isdecimal():
            try:
                table[int(path.name)] = stat_info((path / 'stat').read_text())
            except (FileNotFoundError, ProcessLookupError):
                continue
    return table


def subtree(table, ancestor):
    owned = {ancestor}
    while True:
        expanded = owned | {pid for pid, info in table.items() if info['parent'] in owned}
        if expanded == owned:
            return {pid: table[pid] for pid in owned - {ancestor} if pid in table}
        owned = expanded


def proc_pid_for_local(pid):
    """Map a current-namespace PID onto this procfs mount, rejecting ambiguity."""
    own = namespace_pids(Path('/proc/self/status').read_text())
    if own[-1] != os.getpid():
        raise OSError('procfs namespace mapping does not include the caller')
    if pid == os.getpid():
        return own[0]
    depth = len(own) - 1
    matches = []
    for path in Path('/proc').iterdir():
        if path.name.isdecimal():
            try:
                ids = namespace_pids((path / 'status').read_text())
            except (FileNotFoundError, ProcessLookupError):
                continue
            if len(ids) > depth and ids[depth] == pid:
                matches.append(int(path.name))
    if len(matches) != 1:
        raise OSError('local PID has no unique procfs identity')
    return matches[0]


def reaped_ticks(hz):
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return int((usage.ru_utime + usage.ru_stime) * hz)


class Ownership:
    def __init__(self):
        if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise OSError('Linux pidfd support required before worker launch')
        self.ids = namespace_pids(Path('/proc/self/status').read_text())
        if self.ids[-1] != os.getpid():
            raise OSError('caller namespace identity differs')
        self.depth = len(self.ids) - 1
        self.proc_self = self.ids[0]
        self.handles = []
        self.process = None
        self.libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        if self.libc.prctl(37, ctypes.byref(previous), 0, 0, 0) != 0:
            raise OSError('cannot read child subreaper state')
        self.previous_subreaper = previous.value
        if subtree(process_table(), self.proc_self):
            raise OSError('exclusive worker host requires no pre-existing children')
        fd = os.pidfd_open(os.getpid())
        try:
            signal.pidfd_send_signal(fd, 0)
        finally:
            os.close(fd)
        if self.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError('cannot enable child subreaper')
        self.restored = False

    @staticmethod
    def exited(fd, wait_ms=0):
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        events = poller.poll(wait_ms)
        if any(flags & select.POLLNVAL for _, flags in events):
            raise OSError('invalid owned pidfd')
        return any(flags & select.POLLIN for _, flags in events)

    def attach(self, process):
        self.process = process
        self.handles.append({'proc_pid': None, 'namespace_pid': process.pid,
                             'start_ticks': None, 'fd': os.pidfd_open(process.pid)})

    def discover(self):
        for handle in self.handles[1:]:
            if handle['fd'] is not None and self.exited(handle['fd']):
                os.close(handle['fd'])
                handle['fd']=None
        owned = subtree(process_table(), self.proc_self)
        for pid, info in owned.items():
            identity = (pid, info['start_ticks'])
            if any((h['proc_pid'], h['start_ticks']) == identity for h in self.handles):
                continue
            path = Path('/proc') / str(pid)
            try:
                ids = namespace_pids((path / 'status').read_text())
                local_pid = ids[self.depth]
                if self.handles and self.handles[0]['proc_pid'] is None and local_pid == self.process.pid:
                    self.handles[0].update(proc_pid=pid, start_ticks=info['start_ticks'])
                    continue
                fd = os.pidfd_open(local_pid)
                try:
                    current = stat_info((path / 'stat').read_text())
                    if current['start_ticks'] != info['start_ticks'] or namespace_pids((path / 'status').read_text())[self.depth] != local_pid:
                        raise OSError('descendant identity changed during pidfd acquisition')
                except BaseException:
                    os.close(fd)
                    raise
                self.handles.append({'proc_pid': pid, 'namespace_pid': local_pid,
                                     'start_ticks': info['start_ticks'], 'fd': fd})
            except (FileNotFoundError, ProcessLookupError):
                continue
        return owned

    def reap(self):
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    return
                if self.process is not None and pid == self.process.pid:
                    self.process.returncode = os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                return

    def cleanup(self):
        receipt = {'cleanup_verified': False, 'survivors': [], 'known_live_namespace_pids': [],
                   'signals_sent': [], 'errors': [], 'signal_interface': 'PIDFD'}
        deadline = time.monotonic() + 3
        while True:
            try:
                self.discover()
                for handle in self.handles:
                    if handle['fd'] is not None and not self.exited(handle['fd']):
                        try:
                            signal.pidfd_send_signal(handle['fd'], signal.SIGKILL)
                            receipt['signals_sent'].append({key: value for key, value in handle.items() if key != 'fd'})
                        except ProcessLookupError:
                            pass
                self.reap()
                remaining = self.discover()
                live = [h['namespace_pid'] for h in self.handles if h['fd'] is not None and not self.exited(h['fd'])]
                receipt['survivors'] = sorted(remaining)
                receipt['known_live_namespace_pids'] = sorted(live)
                if not remaining and not live:
                    receipt['cleanup_verified'] = True
                    break
            except (OSError, ValueError, IndexError) as error:
                message = f'{type(error).__name__}: {error}'
                if message not in receipt['errors']:
                    receipt['errors'].append(message)
            if time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        for handle in self.handles:
            if handle['fd'] is not None:os.close(handle['fd'])
        self.handles.clear()
        self.restore()
        return receipt

    def restore(self):
        if not self.restored:
            if self.libc.prctl(36, self.previous_subreaper, 0, 0, 0) != 0:
                raise OSError('cannot restore child subreaper state')
            self.restored = True
