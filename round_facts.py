"""Verified scoring facts and a round-specific projection of the replay history."""
import copy
import hashlib
import json
import math

PLAYERS = ["James Hammond", "Ben Nowak", "Mark Shaw", "Owen Shaw"]
COURSES = ["Ombria", "O’Connor", "Faldo", "Salgados"]
FORMATS = ["match", "best", "solo", "scramble"]
TEAMS = [[[0, 3], [2, 1]], [[1, 3], [2, 0]], [], [[3, 2], [0, 1]]]
RULES = [
    "Each pair adds both players' Stableford points on each hole. Higher sum wins that hole; equal sums halve it. Most holes won wins, with a match clinched when the lead exceeds holes remaining.",
    "Each pair counts its better individual Stableford score on each hole. Highest total wins.",
    "Individual Stableford: highest total wins. Net par is 2 points, net birdie 3, net bogey 1, net double bogey or worse 0.",
    "Two-person scramble: one shared gross score per pair per hole. Lowest total wins. Handicaps do not apply; individual shots or birdies cannot be attributed to either partner.",
]


def played(value):
    return type(value) is int and 1 <= value <= 30


def complete(state, ri):
    scores = state["rounds"][ri]["teamScores" if ri == 3 else "scores"]
    return all(played(score) for row in scores for score in row)


def inputs(state, ri):
    r = state["rounds"][ri]
    keys = ["teamScores" if ri == 3 else "scores", "pars", "verified", "ctp", "tee"]
    if ri != 3:
        keys.append("indexes")
    return {"round": {key: r.get(key) for key in keys},
            "handicaps": state["handicaps"] if ri != 3 else None}


def signature(state, ri):
    value = {"promptVersion": 5, "roundIndex": ri, **inputs(state, ri)}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def hole(gross, par, index, handicap):
    if not played(gross):
        return None
    # Match JavaScript Math.round, including negative and half handicaps.
    h = math.floor(handicap + 0.5)
    strokes = h // 18 + (1 if index <= h % 18 else 0)
    net = gross - strokes
    return {"gross": gross, "net": net, "points": max(0, 2 + par - net)}


def competition(state, ri):
    r, handicaps = state["rounds"][ri], state["handicaps"]
    rows = r["teamScores" if ri == 3 else "scores"]
    common = [all(played(s[i]) for s in rows) for i in range(18)]
    values = [0] * (4 if ri == 2 else 2)
    totals = [0] * 4
    if ri == 2:
        for p in range(4):
            for i in range(18):
                result = hole(rows[p][i], r["pars"][i], r["indexes"][i], handicaps[p])
                if result:
                    totals[p] += result["points"]
                    if common[i]:
                        values[p] += result["points"]
    else:
        for i in range(18):
            if not common[i]:
                continue
            if ri == 3:
                pair = [s[i] for s in rows]
            else:
                points = [[hole(rows[p][i], r["pars"][i], r["indexes"][i], handicaps[p])["points"] for p in team] for team in TEAMS[ri]]
                pair = [sum(p) if ri == 0 else max(p) for p in points]
            if ri == 0:
                values[0] += int(pair[0] > pair[1])
                values[1] += int(pair[1] > pair[0])
            else:
                values = [a + b for a, b in zip(values, pair)]
    best = min(values) if ri == 3 else max(values)
    labels = PLAYERS if ri == 2 else [" & ".join(PLAYERS[p] for p in team) for team in TEAMS[ri]]
    result = {"holes": sum(common), "totals": totals if ri == 2 else values,
              "leaders": [labels[i] for i, value in enumerate(values) if value == best] if any(common) else [],
              "labels": labels, "unit": "holes won" if ri == 0 else "gross strokes" if ri == 3 else "Stableford points"}
    if ri == 2:
        result["ranking"] = values
    return result


def relevant(change, ri):
    path = change["path"]
    return (path[:2] == ["state", "handicaps"] and ri != 3) or (
        len(path) > 3 and path[:3] == ["state", "rounds", ri]
        and path[3] in ({"teamScores", "pars", "verified", "ctp", "tee"} if ri == 3
                       else {"scores", "pars", "indexes", "verified", "ctp", "tee"}))


def apply_change(state, change):
    target = state
    path = change["path"][1:]
    for key in path[:-1]:
        target = target[key]
    if change["exists"]:
        target[path[-1]] = copy.deepcopy(change["after"])
    else:
        del target[path[-1]]


def build_source(events, final_state, ri, through_sequence):
    """Use the same checkpoint/events as history.json without auth or binary files."""
    initial = events[0]["details"]["checkpoint"]["state"]
    state = copy.deepcopy(initial)
    timeline = []
    for event in events[1:]:
        edits = [change for change in event["changes"] if relevant(change, ri)]
        if not edits:
            continue
        before = competition(state, ri)
        for change in edits:
            apply_change(state, change)
        timeline.append({"sequence": event["seq"], "timestamp": event["timestamp"],
                         "type": event["type"], "changes": edits,
                         "before": before, "after": competition(state, ri)})
    if inputs(state, ri) != inputs(final_state, ri):
        raise ValueError("Round history does not reconstruct the current scorecard.")
    r = final_state["rounds"][ri]
    order = []
    clinched = None
    for i in range(18):
        prefix = copy.deepcopy(final_state)
        rows = prefix["rounds"][ri]["teamScores" if ri == 3 else "scores"]
        for row in rows:
            row[i + 1:] = [None] * (17 - i)
        result = competition(prefix, ri)
        facts = []
        for p, row in enumerate(r["teamScores" if ri == 3 else "scores"]):
            gross = row[i]
            delta = gross - r["pars"][i]
            facts.append({"player": p if ri != 3 else None, "team": p if ri == 3 else None,
                          "gross": gross, "versusPar": delta,
                          "grossResult": {-3: "albatross", -2: "eagle", -1: "birdie", 0: "par", 1: "bogey", 2: "double bogey"}.get(delta, f"{delta:+} to par"),
                          "scoring": hole(gross, r["pars"][i], r["indexes"][i], final_state["handicaps"][p]) if ri != 3 else None})
        order.append({"hole": i + 1, "par": r["pars"][i], "scores": facts, "standingsThroughHole": result})
        if ri == 0 and clinched is None and abs(result["totals"][0] - result["totals"][1]) > 17 - i:
            clinched = i + 1
    return {"schema": "portugal2026.round-summary-source", "schemaVersion": 1,
            "round": ri + 1, "course": COURSES[ri], "format": FORMATS[ri], "rules": RULES[ri],
            "players": PLAYERS, "teams": TEAMS[ri], "throughSequence": through_sequence,
            "current": inputs(final_state, ri), "result": competition(final_state, ri),
            "matchClinchedAfterHole": clinched,
            "finishCheck": {"atTurn": order[8]["standingsThroughHole"],
                            "beforeLastHole": order[16]["standingsThroughHole"],
                            "afterLastHole": order[17]["standingsThroughHole"],
                            "scoreUnit": competition(final_state, ri)["unit"],
                            "instruction": "Compare these exact standings when describing the finish. A tie before hole 18 is not a deficit. Stableford gaps are points, never shots. Do not invent bets or a playoff."},
            "nearestPin": {"winner": PLAYERS[r["ctp"]],
                           "hole": max((i + 1 for i, par in enumerate(r["pars"]) if par == 3), default=None),
                           "overallBonusPoints": 1, "affectsRoundWinner": False} if r["ctp"] is not None else None,
            "history": {"source": "The checkpoint and relevant events from portugal2026.history (history.json).",
                        "initial": inputs(initial, ri), "events": timeline,
                        "note": "Timestamps record data entry, not shot times. Imports and corrections are not on-course comebacks. Earlier play before an import is only known from the scorecard."},
            "holeOrder": order,
            "note": "holeOrder is the final corrected scorecard in hole-number order, not a timestamped record of shots. Do not invent shot descriptions, putts, weather, motives or emotions. Only claim a comeback or decisive last hole supported by these standings."}
