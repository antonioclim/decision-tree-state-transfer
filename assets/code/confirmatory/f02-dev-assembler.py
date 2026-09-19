"""F02 DEV cell assembler. No p-values, sample-size decisions or CONF access."""
from __future__ import annotations
from collections import defaultdict
import math

STATE = ("PERSIST", "RESTART-CART", "CHAMPION-RESEED")
MATERIAL = ("MATERIAL-REPLACE", "STRUCTURAL-SHAM")
STATE_STATUSES = ("COMPLETE", "ALGORITHMIC_FAILURE", "TREATMENT_UNAVAILABLE")
MATERIAL_INELIGIBLE = ("NO_ELIGIBLE_SITE", "PARENT_UNAVAILABLE")


def _finite_loss(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1


def assemble(records):
    cells = {}
    for r in records:
        if r.get("partition") != "DEV" or r.get("schema_version") != 1:
            raise ValueError("F02 assembler accepts DEV schema v1 only")
        key = (r.get("scenario"), r.get("realisation"), r.get("optimiser"), r.get("checkpoint"), r.get("treatment"))
        if key in cells:
            raise ValueError("duplicate treatment cell")
        if r.get("kind") not in ("state", "material") or r.get("treatment") not in STATE + MATERIAL:
            raise ValueError("unknown treatment")
        if not isinstance(r.get("predictions"), int) or isinstance(r.get("predictions"), bool) or r["predictions"] < 1:
            raise ValueError("complete future denominator is required")
        if not _finite_loss(r.get("loss")):
            raise ValueError("every scientific treatment record needs a bounded full-horizon loss")
        cells[key] = r

    units = defaultdict(lambda: {"H1": [], "H2": [], "H3_conditional": [], "H3_policy": [], "material_eligible": 0, "material_total": 0})
    bases = sorted({k[:4] for k in cells})
    for base in bases:
        scenario, realisation, optimiser, checkpoint = base
        unit = units[(scenario, realisation)]
        state = {a: cells.get(base + (a,)) for a in STATE}
        if any(state.values()):
            if not all(state.values()): raise ValueError("incomplete paired state treatments")
            if any(x["status"] not in STATE_STATUSES for x in state.values()): raise ValueError("invalid state scientific status")
            if len({x["predictions"] for x in state.values()}) != 1: raise ValueError("paired state horizons differ")
            unit["H1"].append(state["RESTART-CART"]["loss"] - state["PERSIST"]["loss"])
            unit["H2"].append(state["CHAMPION-RESEED"]["loss"] - state["PERSIST"]["loss"])

        material = {a: cells.get(base + (a,)) for a in MATERIAL}
        if any(material.values()):
            if not all(material.values()): raise ValueError("incomplete paired material treatments")
            unit["material_total"] += 1
            eligibility = {x.get("eligible") for x in material.values()}
            if len(eligibility) != 1 or not all(type(x.get("eligible")) is bool for x in material.values()): raise ValueError("paired material eligibility differs")
            if len({x["predictions"] for x in material.values()}) != 1: raise ValueError("paired material horizons differ")
            statuses = {x["status"] for x in material.values()}
            d = material["MATERIAL-REPLACE"]["loss"] - material["STRUCTURAL-SHAM"]["loss"]
            if True in eligibility:
                if statuses != {"COMPLETE"}: raise ValueError("eligible material pair incomplete")
                unit["H3_conditional"].append(d); unit["H3_policy"].append(d); unit["material_eligible"] += 1
            else:
                if len(statuses) != 1 or next(iter(statuses)) not in MATERIAL_INELIGIBLE: raise ValueError("ineligible material pair has inconsistent status")
                if d != 0.0: raise ValueError("ineligible material no-op pair must have zero policy contrast")
                unit["H3_policy"].append(d)

    return {"partition": "DEV", "scientific_admission": False, "confirmation_authorised": False,
            "units": [{"scenario": k[0], "realisation": k[1], **v} for k, v in sorted(units.items())]}
