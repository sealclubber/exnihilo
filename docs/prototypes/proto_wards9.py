"""Stage prototype (Voronoi arterials): WATER, then ROADS. No wards, lots or buildings.
Order: 1 water (broad bends only)  2 highways from the map's exits; a bridge is set square to the river first and
the road is bent to line up with it  3 harbour where a sea route meets the shore  4 the ground the town covers
5 arterials off the highways, trimmed to the town  6 streets: each block between roads split until small."""
import sys, math
import numpy as np
from scipy.ndimage import gaussian_filter
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union, substring
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection

SCEN = {
 "river": dict(title="River town, one through road (Badanos-like)", buildings=1825, exits=[(61, "trail"), (227, "trail")], river=dict(inb=160, outb=40, off=260), sea=None, seed=7),
 "port":  dict(title="Sea port, three roads and a sea route", buildings=2600, exits=[(350, "road"), (60, "road"), (285, "trail"), (170, "sea")], river=None, sea=dict(bearing=170, dist=330), seed=5),
 "village": dict(title="Village, no water", buildings=170, exits=[(320, "trail"), (115, "trail")], river=None, sea=None, seed=3),
 "bigriver": dict(title="City on both banks, four roads", buildings=5200, exits=[(10, "road"), (95, "road"), (200, "road"), (275, "road")], river=dict(inb=250, outb=60, off=120), sea=None, seed=11),
}
name = sys.argv[1]; S = SCEN[name]; out = sys.argv[2]
rng = np.random.default_rng(S["seed"])
HW, ART, ST = 10.0, 7.0, 4.5
TARGET = S["buildings"] * 200 / 0.8
R = math.sqrt(TARGET / math.pi)
BIG = max(R * 3.2, 700)

def ray(b, r):
    a = math.radians(b); return np.array([math.sin(a) * r, -math.cos(a) * r])
def chaikin(p, n=3):
    p = np.asarray(p, float)
    for _ in range(n):
        q = [p[0]]
        for a, b in zip(p[:-1], p[1:]): q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        q.append(p[-1]); p = np.array(q)
    return p
def wander(p0, p1, amp, k=4):
    p0, p1 = np.array(p0, float), np.array(p1, float); d = p1 - p0; L = np.linalg.norm(d)
    n = np.array([-d[1], d[0]]) / L; ts = np.linspace(0, 1, k + 2)
    off = gaussian_filter(rng.normal(0, amp, k + 2), 1.0) * np.sin(np.pi * ts)
    return chaikin([p0 + d * t + n * o for t, o in zip(ts, off)], 4)
def tangent(line, at):
    p, q = line.interpolate(max(at - 10, 0)), line.interpolate(min(at + 10, line.length))
    t = np.array([q.x - p.x, q.y - p.y]); return t / np.linalg.norm(t)

# ---------- 1 water
water = None; river = None; coast = None; RW = 30
if S["river"]:
    rv = S["river"]; a, b = ray(rv["inb"], BIG * 1.3), ray(rv["outb"], BIG * 1.3)
    mid_dir = (a + b); mid_dir = mid_dir / (np.linalg.norm(mid_dir) + 1e-9)
    m = mid_dir * rv["off"]                                   # passes this far from the centre
    # two broad bends, nothing tighter: control points a third of the way along, pushed gently aside
    ax = (m - a); nrm = np.array([-ax[1], ax[0]]) / np.linalg.norm(ax)
    sg = 1 if rng.random() < 0.5 else -1
    c1 = a + (m - a) * 0.5 + nrm * sg * rng.uniform(0.07, 0.13) * np.linalg.norm(m - a)
    bx = (b - m); nrm2 = np.array([-bx[1], bx[0]]) / np.linalg.norm(bx)
    c2 = m + (b - m) * 0.5 + nrm2 * sg * rng.uniform(0.07, 0.13) * np.linalg.norm(b - m)
    river = LineString(chaikin([a, c1, m, c2, b], 5))
    water = river.buffer(RW / 2)
if S["sea"]:
    se = S["sea"]; c = ray(se["bearing"], se["dist"]); t = np.array([-ray(se["bearing"], 1)[1], ray(se["bearing"], 1)[0]])
    xs = np.linspace(-BIG * 1.5, BIG * 1.5, 14)
    off = gaussian_filter(rng.normal(0, 190, 14), 1.3)             # broad bays and headlands only
    pts = [c + t * x + ray(se["bearing"], 1) * o for x, o in zip(xs, off)]
    coast = LineString(chaikin(pts, 4))
    far = [pts[-1] + ray(se["bearing"], BIG * 3), pts[0] + ray(se["bearing"], BIG * 3)]
    sea = Polygon(list(coast.coords) + far)
    water = sea if water is None else unary_union([water, sea])

# ---------- 2 highways (bridges first, roads bent to meet them square)
bridges = []
def bridge_site(toward, near=(0.0, 0.0), avoid=()):
    """Where to cross: a point on the river, not far from 'near', where the river runs most nearly square to the way we are going."""
    best, bs = None, -1e9
    for d in np.arange(0, river.length, 20):
        X = river.interpolate(d); c = np.array([X.x, X.y])
        if np.hypot(*(c - np.array(near))) > R * 1.5: continue
        if any(X.distance(Point(*a_)) < 220 for a_ in avoid): continue
        t = tangent(river, d); n = np.array([-t[1], t[0]]); go = np.array(toward) - c; go /= np.linalg.norm(go)
        score = abs(np.dot(n, go)) * 300 - 0.6 * np.hypot(*(c - np.array(near)))
        if score > bs: bs, best = score, (c, n if np.dot(n, go) > 0 else -n)
    return best
def make_bridge(c, n):
    h = RW / 2 + 8; A, B = c - n * h, c + n * h; bridges.append(LineString([A, B])); return A, B
def leg(p0, p1, amp):
    return wander(p0, p1, amp)
def with_bridge(line):
    """An arterial that meets the river: square bridge at a good site near where it arrives."""
    X = line.intersection(river); X = min(X.geoms, key=lambda p: line.project(p)) if hasattr(X, "geoms") else X
    site = bridge_site(np.array(line.coords[-1]), near=(X.x, X.y), avoid=[tuple(b.centroid.coords[0]) for b in bridges])
    if site is None: return None
    c, n = site; A, B = make_bridge(c, n); start = np.array(line.coords[0])
    a_in = chaikin([start, A - n * 90, A - n * 10], 4); b_out = chaikin([B + n * 10, B + n * 90, np.array(line.coords[-1])], 4)
    return LineString(np.vstack([a_in, A, B, b_out]))
def resmooth(pts, step=45):
    l = LineString(pts); n = max(int(l.length / step), 3)
    return chaikin([np.array(l.interpolate(i / n, normalized=True).coords[0]) for i in range(n + 1)], 3)
main_bridge = []; extra_hw = []; side_bridges = []
NB = 1 if S["buildings"] < 1500 else (2 if S["buildings"] < 4000 else 3)      # bridges, by the size of the town
def highway_between(pa, pb):
    """exit a -> centre -> exit b. If the far exit lies across the river the crossing is planned here, before anything else exists:
    a main bridge square to the river, and for bigger towns side bridges the road splits to reach and then rejoins."""
    centre = np.zeros(2); first = leg(pa, centre, 0.04 * BIG)[:-1] if pa is not None else np.zeros((0, 2))
    if river is not None and LineString([centre, pb]).crosses(river):
        if main_bridge: A, B, n, lead = main_bridge[0]
        else:
            c, n = bridge_site(pb); A, B = make_bridge(c, n)
            gap_ = float(np.hypot(*(A - centre))); lead = 110 if NB == 1 else float(np.clip(0.72 * gap_, 90, 210))
            main_bridge.append((A, B, n, lead))
            s0 = river.project(Point(c)); Ps = A - n * (lead - 15) if gap_ > 230 else centre; Pj = B + n * (lead - 15)
            astride = gap_ <= 230
            a_est = math.sqrt(0.5 * S["buildings"] * 330 / math.pi * 1.12)
            for k_ in range(NB - 1):
                sgn = 1 if k_ % 2 == 0 else -1
                sk = s0 + sgn * (k_ // 2 + 1) * (float(np.clip(0.55 * a_est, 150, 270)) * rng.uniform(0.9, 1.1) if astride else rng.uniform(150, 200))
                X = river.interpolate(sk); t = tangent(river, sk); nk = np.array([-t[1], t[0]])
                if np.dot(nk, n) < 0: nk = -nk
                ck = np.array([X.x, X.y]); Ak, Bk = make_bridge(ck, nk)
                if astride:
                    side_bridges.append((Ak, Bk, nk)); continue
                extra_hw.append(LineString(np.vstack([chaikin([Ps, (Ps + Ak - nk * 55) / 2 + nk * 0, Ak - nk * 55, Ak - nk * 8], 4), Ak, Bk,
                                                      chaikin([Bk + nk * 8, Bk + nk * 55, (Bk + nk * 55 + Pj) / 2, Pj], 4)])))
        pre = resmooth(np.vstack([first, centre, (centre + A - n * lead) / 2, A - n * lead, A - n * 12])) if np.hypot(*(A - centre)) > lead + 20 else resmooth(np.vstack([first, centre, A - n * 12]))
        post = resmooth(np.vstack([B + n * 12, B + n * lead, (B + n * lead + pb) / 2, pb]))
        return LineString(np.vstack([pre, A, B, post]))
    return LineString(resmooth(np.vstack([first, leg(centre, pb, 0.04 * BIG)])))

land = [e for e in S["exits"] if e[1] != "sea"]; seas = [e for e in S["exits"] if e[1] == "sea"]
highways = []; used = set()
for i, (b1, k1) in enumerate(land):                               # opposite exits make one through road
    if i in used: continue
    opp = [j for j, (b2, _) in enumerate(land) if j != i and j not in used and abs(((b1 - b2 + 180) % 360) - 180) > 150]
    if opp:
        j = opp[0]; used |= {i, j}
        pa, pb = ray(b1, BIG), ray(land[j][0], BIG)
        if river is not None and LineString([(0, 0), tuple(pa)]).crosses(river): pa, pb = pb, pa
        l = highway_between(pa, pb)
    else:
        used.add(i); pb = ray(b1, BIG)
        l = highway_between(None, pb)
    highways.append(l)

# a side bridge's road runs on from each end until it joins the nearest highway on that bank
for Ak, Bk, nk in side_bridges:
    legs_ = []
    for end, sgn in ((Ak, -1), (Bk, 1)):
        out_pt = end + sgn * nk * 70; best_t, bd_ = None, 1e9
        for h in highways:
            for dd in np.arange(0, h.length, 15):
                p_ = np.array(h.interpolate(dd).coords[0])
                if np.hypot(*p_) > R * 1.3 or LineString([out_pt, p_]).crosses(river): continue
                d_ = np.hypot(*(p_ - out_pt)) + 0.6 * abs(np.dot(p_ - out_pt, np.array([-nk[1], nk[0]])))   # prefer going on ahead to veering along the bank
                if d_ < bd_: bd_, best_t = d_, p_
        legs_.append(chaikin([end + sgn * nk * 8, out_pt, (out_pt + best_t) / 2 + rng.normal(0, 8, 2), best_t], 4) if best_t is not None else np.array([end + sgn * nk * 8, out_pt]))
    extra_hw.append(LineString(np.vstack([legs_[0][::-1], Ak, Bk, legs_[1]])))
highways += extra_hw
# ---------- 3 harbour: a sea route is a road down to a quay with piers
harbour = []; quay_line = None
for b, _ in seas:
    probe = LineString([(0, 0), tuple(ray(b, BIG))]); hit = probe.intersection(coast)
    hit = min(hit.geoms, key=lambda p: p.distance(Point(0, 0))) if hasattr(hit, "geoms") else hit
    s = coast.project(hit); qa, qb = s - 110, s + 110
    quay_line = substring(coast, qa, qb).parallel_offset(9, "right")
    if quay_line.distance(Point(0, 0)) > coast.distance(Point(0, 0)) + 1: quay_line = substring(coast, qa, qb).parallel_offset(9, "left")
    qm = quay_line.interpolate(0.5, normalized=True)
    highways.append(LineString(wander((0, 0), (qm.x, qm.y), 25)))
    t = tangent(coast, s); seaward = ray(b, 1)
    for f in (0.2, 0.5, 0.8):
        p = quay_line.interpolate(f, normalized=True); p = np.array([p.x, p.y])
        harbour.append(LineString([p, p + seaward * 62]).buffer(4.5, cap_style=2))
    harbour.append(quay_line.buffer(7, cap_style=2))

# ---------- 4 ground
g = 12.0 if R < 500 else 16.0; ext = R * 2.6
gx, gy = np.meshgrid(np.arange(-ext, ext, g), np.arange(-ext, ext, g)); P = np.c_[gx.ravel(), gy.ravel()]
def dist_to(line, P):
    c = np.array(line.coords); best = np.full(len(P), 1e9)
    for a, b in zip(c[:-1], c[1:]):
        ab = b - a; t = np.clip(((P - a) @ ab) / (ab @ ab + 1e-9), 0, 1)
        best = np.minimum(best, np.hypot(*(P - (a + t[:, None] * ab)).T))
    return best
dh = np.min([dist_to(h, P) for h in highways], axis=0)
noise = gaussian_filter(rng.normal(0, 1, gx.shape), 7).ravel(); noise = noise / np.abs(noise).max() * 0.18 * R
import os
PH, PR, CL = float(os.environ.get('PH', 0.3)), float(os.environ.get('PR', 1.0)), float(os.environ.get('CL', 30))
cost = PH * dh + PR * np.hypot(*P.T) + noise
if water is not None:
    from shapely import contains_xy
    wet = contains_xy(water.buffer(10), P[:, 0], P[:, 1]); cost[wet] = 1e9
k = int(TARGET * 2.6 / (g * g)); thr = np.sort(cost)[k]
ground = unary_union([box(x - g / 2, y - g / 2, x + g / 2, y + g / 2) for (x, y), c in zip(P, cost) if c <= thr])
ground = ground.buffer(CL, join_style=1).buffer(-CL, join_style=1).buffer(-12).buffer(12)
ground = max(ground.geoms, key=lambda q: q.area) if hasattr(ground, "geoms") else ground
ground = Polygon(ground.exterior)
if water is not None: ground = ground.difference(water.buffer(4))

# ---------- 4b the wall: one rounded ring, drawn before the mesh so the mesh follows it
WALLED = os.environ.get("WALLED", "1") == "1"
from shapely import affinity
def ngon(c, r, n, rot, jit=0.12):
    return Polygon([c + r * (1 + rng.uniform(-jit, jit)) * np.array([math.cos(rot + 2 * math.pi * k_ / n), math.sin(rot + 2 * math.pi * k_ / n)]) for k_ in range(n)])
h0 = highways[0]; t0 = tangent(h0, h0.project(Point(0, 0))); axis = math.atan2(t0[1], t0[0])
ratio = 1.4 if len(highways) - len(extra_hw) == 1 else 1.12
A_core = 0.5 * S["buildings"] * 330
a_ = math.sqrt(A_core / math.pi * ratio); b_ = a_ / ratio
ph1, ph2 = rng.uniform(0, 6.28, 2)
ths = np.linspace(0, 2 * math.pi, 240, endpoint=False)
rr = 1 + 0.06 * np.sin(2 * ths + ph1) + 0.04 * np.sin(3 * ths + ph2)
ring = np.c_[a_ * rr * np.cos(ths), b_ * rr * np.sin(ths)]
ca_, sa_ = math.cos(axis), math.sin(axis); ring = np.c_[ring[:, 0] * ca_ - ring[:, 1] * sa_, ring[:, 0] * sa_ + ring[:, 1] * ca_]
wall_curve = LineString(np.vstack([ring, ring[:1]]))
n_tw = max(8, int(round(wall_curve.length / 85)))                 # towers; the wall runs straight between them
towers = [np.array(wall_curve.interpolate((k_ + rng.uniform(-0.15, 0.15)) / n_tw, normalized=True).coords[0]) for k_ in range(n_tw)]
wall_poly = Polygon(towers); wall_line = LineString(towers + towers[:1])
# special wards: small, placed by rule, cut out before ordinary wards exist
r_pl = math.sqrt(float(np.clip(S["buildings"] * 1.3, 1200, 6500)) / 2.0)           # plaza: about 45-80 m across
plaza = ngon(np.zeros(2), r_pl, 4, axis + math.pi / 4, 0.10)
dirs = sorted(math.atan2(*(np.array(h.interpolate(min(h.project(Point(0, 0)) + sgn * 60, h.length)).coords[0])[::-1])) for h in highways for sgn in ((1, -1) if h.project(Point(0, 0)) > 30 else (1,)))
gaps_ = [((dirs[(k_ + 1) % len(dirs)] - dirs[k_]) % (2 * math.pi), dirs[k_]) for k_ in range(len(dirs))]
gw, g0 = max(gaps_); cdir = g0 + gw / 2
r_ca = math.sqrt(float(np.clip(S["buildings"] * 3.2, 3500, 14000)) / 2.6)          # castle: about 70-120 m across
castle = None
if S["buildings"] > 1000:
    for dist_ in np.arange(r_pl + r_ca + 30, a_, 15):
        cc_ = dist_ * np.array([math.cos(cdir), math.sin(cdir)]); cand_ = ngon(cc_, r_ca, 5, rng.uniform(0, 6.28), 0.10)
        if wall_poly.buffer(-12).contains(cand_) and (water is None or water.distance(cand_) > 15) and all(h.distance(cand_) > 8 for h in highways):
            castle = cand_; break
# ---------- 5 arterials: the edges of a coarse Voronoi mesh, with the highways and river already on its cell edges
from scipy.spatial import Voronoi
D = float(np.clip(0.62 * R, 120, 300))                       # arterial spacing
minx, miny, maxx, maxy = ground.buffer(D).bounds
seeds = []
for _ in range(6000):
    p = np.array([rng.uniform(minx, maxx), rng.uniform(miny, maxy)])
    if all(np.hypot(*(p - q)) > D * rng.uniform(0.85, 1.0) for q in seeds): seeds.append(p)
lines_on_edges = list(highways) + ([river] if river is not None else []) + ([wall_line] if WALLED else [])
hw_union = unary_union(lines_on_edges)
seeds = [p for p in seeds if hw_union.distance(Point(p)) > 0.42 * D]
for l in lines_on_edges:                                     # mirrored pairs put the line on cell edges
    sdist = rng.uniform(0, D)
    while sdist < l.length:
        p = l.interpolate(sdist); c = np.array([p.x, p.y])
        if np.hypot(*c) < R * 2.6:
            t = tangent(l, sdist); n = np.array([-t[1], t[0]]); o = 0.5 * D * rng.uniform(0.85, 1.1)
            seeds += [c + n * o, c - n * o]
        sdist += D * rng.uniform(0.8, 1.25)
seeds = np.array(seeds)
keep = np.ones(len(seeds), bool)
for i in range(len(seeds)):
    for j in range(i):
        if keep[j] and np.hypot(*(seeds[i] - seeds[j])) < 0.45 * D: keep[i] = False; break
seeds = seeds[keep]
vor = Voronoi(seeds); V = vor.vertices.copy()
gb = ground.buffer(20)
edges = []
for a_, b_ in vor.ridge_vertices:
    if a_ < 0 or b_ < 0: continue
    seg = LineString([V[a_], V[b_]]); m = seg.interpolate(0.5, normalized=True)
    if not gb.contains(m) or seg.length < 25: continue
    if any(h.distance(m) < 0.2 * D for h in highways): continue            # that edge is the highway itself
    if WALLED and wall_line.distance(m) < 0.2 * D and not seg.crosses(wall_line): continue
    if river is not None and river.distance(m) < RW / 2 + 0.18 * D and not seg.crosses(river): continue
    edges.append((a_, b_))

# ================= WARDS: the cells of the mesh. Roads, river and wards share the same corners. =================
from shapely import affinity
from shapely.strtree import STRtree
N_TARGET = S["buildings"]
GAP, ALLEY = 6.5, 4.2
MAIN = 7.0
nbr = {}
for a_, b_ in edges: nbr.setdefault(a_, []).append(b_); nbr.setdefault(b_, []).append(a_)
hw_u = unary_union(highways); main_streets = []; used_nodes = set()
starts = sorted([v for v in nbr if hw_u.distance(Point(V[v])) < 0.3 * D], key=lambda v: math.hypot(*V[v]))
for v0 in starts:
    if any(math.hypot(*(V[v0] - V[u])) < 0.9 * D for u in used_nodes): continue
    q = hw_u.interpolate(hw_u.project(Point(V[v0]))); prev = np.array([q.x, q.y]); chain = [prev, V[v0]]; cur = v0; seen = {v0}; idx = [v0]
    while True:
        d1 = chain[-1] - chain[-2]; best = None
        for w in nbr[cur]:
            if w in seen or hw_u.distance(Point(V[w])) < 0.3 * D: continue
            d2 = V[w] - V[cur]; c = np.dot(d1, d2) / (np.hypot(*d1) * np.hypot(*d2) + 1e-9)
            if best is None or c > best[0]: best = (c, w)
        if best is None or best[0] < 0.6: break
        cur = best[1]; seen.add(cur); chain.append(V[cur]); idx.append(cur)
    if len(chain) >= 3:
        for _ in range(2):
            pts_ = [prev] + [V[i_].copy() for i_ in idx]
            for j_ in range(1, len(pts_) - 1): V[idx[j_ - 1]] = (pts_[j_ - 1] + 2 * pts_[j_] + pts_[j_ + 1]) / 4
        main_streets.append(LineString([prev] + [V[i_] for i_ in idx])); used_nodes |= seen
road_cut = unary_union([m.buffer(MAIN / 2 - GAP / 2 + 0.5) for m in main_streets] + [h.buffer(HW / 2 + 1.5) for h in highways] + ([water.buffer(7)] if water is not None else []))
def cost_at(p):
    pt = Point(p); return PH * min(h.distance(pt) for h in highways) + PR * math.hypot(*p)
WALLED = os.environ.get("WALLED", "1") == "1"
cells = {}
for i, reg_i in enumerate(vor.point_region):
    reg = vor.regions[reg_i]
    if -1 in reg or len(reg) < 3: continue
    cell = Polygon(V[reg])
    if not cell.is_valid: cell = cell.buffer(0)
    if cell.is_empty or not ground.buffer(D * 0.25).contains(cell.centroid): continue
    cells[i] = cell
ccost = {i: cost_at((c.centroid.x, c.centroid.y)) for i, c in cells.items()}
order_c = sorted(cells, key=lambda i: ccost[i])
if WALLED and water is not None:
    wl = wall_line.difference(water.buffer(1.0))
    wall_parts = [q for q in (wl.geoms if hasattr(wl, "geoms") else [wl]) if q.length > 30]
elif WALLED: wall_parts = [wall_line]
else: wall_parts = []
# a ring that only just reaches over the river stays on its own bank: the river is that side of the defences
if WALLED and river is not None:
    far = [q for q in (wall_poly.difference(river.buffer(RW / 2)).geoms if hasattr(wall_poly.difference(river.buffer(RW / 2)), "geoms") else []) if not q.contains(Point(0, 0))]
    far_share = sum(q.area for q in far) / wall_poly.area
    if far_share < 0.3:
        wall_parts = [wp for wp in wall_parts if not LineString([(0, 0), wp.interpolate(0.5, normalized=True).coords[0]]).crosses(river)]
        for q in far: wall_poly = wall_poly.difference(q.buffer(1))
gates = []
if WALLED:
    for l in list(highways) + list(main_streets):
        x = l.intersection(unary_union(wall_parts)) if wall_parts else Point()
        for q in (x.geoms if hasattr(x, "geoms") else [x]):
            if q.geom_type == "Point" and all(q.distance(g_) > 60 for g_ in gates): gates.append(q)
    if river is not None:
        for br in bridges:
            for end in (br.coords[0], br.coords[-1]):
                pe = Point(end)
                if wall_poly.buffer(25).contains(pe) and wall_line.distance(pe) > 40 and far_share < 0.3: gates.append(pe)
    road_cut = unary_union([road_cut] + [wp.buffer(6.5) for wp in wall_parts])
road_cut = unary_union([road_cut, plaza.buffer(GAP / 2 + 1)] + ([castle.buffer(GAP / 2 + 3)] if castle is not None else []))
plaza_i = min(cells, key=lambda i: cells[i].centroid.distance(Point(0, 0))); castle_i = None
# districts: groups of wards, bounded where possible by highways, main streets and the river
dseed = [plaza_i]
live = [i for i in order_c[: int(len(order_c) * 0.6)]]
while len(dseed) < min(7, max(3, len(live) // 5)):
    dseed.append(max(live, key=lambda i: min(cells[i].centroid.distance(cells[j].centroid) for j in dseed)))
barr = [(h, 160) for h in highways] + [(m, 90) for m in main_streets] + ([(river, 350)] if river is not None else []) + [(wp, 220) for wp in wall_parts]
def district_of(i):
    p = cells[i].centroid; best, bd = 0, 1e9
    for k_, j in enumerate(dseed):
        seg = LineString([p, cells[j].centroid]); d_ = seg.length + sum(pen for l, pen in barr if seg.crosses(l))
        if d_ < bd: best, bd = k_, d_
    return best
DCHAR = [(1.25, "#6f6485"), (0.8, "#5c7688"), (1.05, "#666a7e"), (1.5, "#806a7c"), (0.7, "#5f8079"), (0.95, "#73708f"), (0.85, "#7a7868")]
wards = []            # (polygon, cell index, district)
for i, cell in cells.items():
    blk = cell.difference(road_cut).buffer(-GAP / 2, join_style=2)
    d_ = district_of(i)
    for part in (blk.geoms if hasattr(blk, "geoms") else [blk]):
        if part.geom_type == "Polygon" and part.area > 500: wards.append((part, i, d_))

def bisect(poly, gap, ratio=None, ang=0.0):
    mrr = poly.minimum_rotated_rectangle; c = np.array(mrr.exterior.coords); e1, e2 = c[1] - c[0], c[2] - c[1]
    a0, long_e, short_e = (c[0], e1, e2) if np.hypot(*e1) >= np.hypot(*e2) else (c[1], e2, -e1)
    r = ratio if ratio is not None else rng.uniform(0.38, 0.62)
    p1 = a0 + long_e * r + short_e * 0.5; u = short_e / (np.hypot(*short_e) + 1e-9)
    ca, sa = math.cos(ang), math.sin(ang); u = np.array([u[0] * ca - u[1] * sa, u[1] * ca + u[0] * sa])
    res = poly.difference(LineString([p1 - u * 3000, p1 + u * 3000]).buffer(gap / 2, cap_style=2))
    return [q for q in (res.geoms if hasattr(res, "geoms") else [res]) if q.geom_type == "Polygon" and q.area > 60]
def blocks_of(ward, lim):
    if ward.area < lim: return [ward]
    hs = bisect(ward, ALLEY, ang=rng.normal(0, 0.10))
    if len(hs) < 2: return [ward]
    return [b for h in hs for b in blocks_of(h, lim * rng.uniform(0.9, 1.1))]

# ================= BUILDINGS: rectangles and Ls along each block's edge, courtyard left in the middle =================
def rect(p, t, n, w, d):                        # p = street-side corner, t along the edge, n inward
    return Polygon([p, p + t * w, p + t * w + n * d, p + n * d])
passages = []
def edge_buildings(block, sc=1.0):
    out_ = []; shell = block.simplify(1.2); inner_ = block.buffer(-0.25, join_style=2); want_pass = rng.random() < 0.35; block_pass = []
    if shell.geom_type != "Polygon" or shell.is_empty: return out_
    core = block.buffer(0.3)
    c = np.array(shell.exterior.coords)
    if Polygon(c).exterior.is_ccw: c = c[::-1]
    order = sorted(range(len(c) - 1), key=lambda i: -np.hypot(*(c[i + 1] - c[i])))
    placed = []
    for i in order:
        a, b = c[i], c[i + 1]; L = np.hypot(*(b - a))
        if L < 7: continue
        t = (b - a) / L; n = np.array([-t[1], t[0]])
        if not block.contains(Point(*(a + t * L / 2 + n * 2.0))): n = -n
        mrr_ = block.minimum_rotated_rectangle; mc = np.array(mrr_.exterior.coords)
        short = min(np.hypot(*(mc[1] - mc[0])), np.hypot(*(mc[2] - mc[1])))
        x = 0.0; depth_row = rng.uniform(10, 14) * sc ** 0.5
        if short < 26: depth_row = short                       # too shallow for a court: one row right through
        else: depth_row = min(depth_row, 0.34 * short)          # otherwise always leave a courtyard
        while x < L - 5:
            if want_pass and short >= 26 and x > L * 0.35 and L > 40:
                pz_ = rect(a + t * x, t, n, 3.6, depth_row * 1.15).intersection(block); passages.append(pz_); block_pass.append(pz_); x += 3.6; want_pass = False; continue
            w = min(float(np.clip(rng.lognormal(math.log(12.5 * sc), 0.33), 6.5, 30)), L - x)
            if L - x - w < 7: w = L - x
            d = depth_row * rng.uniform(0.9, 1.12)
            body = rect(a + t * x, t, n, w, d)
            if rng.random() < 0.5 and w > 10 and short >= 26:      # a rear wing makes an L
                ww = w * rng.uniform(0.4, 0.6); wd = rng.uniform(4, 8); off = 0 if rng.random() < 0.5 else w - ww
                body = body.union(rect(a + t * (x + off) + n * d, t, n, ww, wd))
            x += w
            full = body.area
            body = body.intersection(inner_)
            if block_pass: body = body.difference(unary_union(block_pass).buffer(0.3))
            if placed: body = body.difference(unary_union(placed).buffer(0.3))
            if body.is_empty: continue
            if body.geom_type != "Polygon": body = max(body.geoms, key=lambda q: q.area) if hasattr(body, "geoms") else body
            if body.geom_type != "Polygon" or body.area < 0.6 * full or body.area < 60: continue
            placed.append(body)
    return placed
def oriented(block):
    mrr = block.minimum_rotated_rectangle; c = np.array(mrr.exterior.coords); e1, e2 = c[1] - c[0], c[2] - c[1]
    if np.hypot(*e1) < np.hypot(*e2): e1, e2 = e2, e1
    ctr = c[:4].mean(axis=0); return ctr, e1 / np.hypot(*e1), e2 / np.hypot(*e2), np.hypot(*e1), np.hypot(*e2)
def church(block, k=1.0):                        # a cross: nave and transept
    ctr, u, v, L, W = oriented(block); l, w = min(L * 0.8, 46) * k, min(W * 0.42, 13) * k
    nave = Polygon([ctr - u * l / 2 - v * w / 2, ctr + u * l / 2 - v * w / 2, ctr + u * l / 2 + v * w / 2, ctr - u * l / 2 + v * w / 2])
    tc = ctr + u * l * 0.18; tl, tw = min(W * 0.8, 30) * k, w * 0.9
    tr = Polygon([tc - v * tl / 2 - u * tw / 2, tc + v * tl / 2 - u * tw / 2, tc + v * tl / 2 + u * tw / 2, tc - v * tl / 2 + u * tw / 2])
    return nave.union(tr)
def hall(block, k=1.0):                          # a U-shaped hall round a yard
    ctr, u, v, L, W = oriented(block); l, w = min(L * 0.8, 44) * k, min(W * 0.8, 30) * k
    outer = Polygon([ctr - u * l / 2 - v * w / 2, ctr + u * l / 2 - v * w / 2, ctr + u * l / 2 + v * w / 2, ctr - u * l / 2 + v * w / 2])
    yard = Polygon([ctr - u * l * 0.28 - v * w * 0.12, ctr + u * l * 0.28 - v * w * 0.12, ctr + u * l * 0.28 + v * w * 0.6, ctr - u * l * 0.28 + v * w * 0.6])
    return outer.difference(yard)
all_blocks = []
for (w_, ci, d_) in wards:
    sc = DCHAR[d_ % len(DCHAR)][0] * float(np.clip(rng.lognormal(0, 0.12), 0.8, 1.25))
    for blk in blocks_of(w_, rng.uniform(2200, 4600) * sc): all_blocks.append((blk, ci, d_, sc))
# where landmarks go: a church on the plaza, then halls on highways and main streets, spread through the districts
big_roads = unary_union(list(highways) + list(main_streets))
reserved = {}
okb = [k_ for k_, (blk, ci, d_, sc) in enumerate(all_blocks) if 1300 < blk.area < 5200 and oriented(blk)[3] >= 42 and oriented(blk)[4] >= 30 and ccost[ci] < np.quantile(list(ccost.values()), 0.45)]
if okb:
    k_ = min(okb, key=lambda k_: all_blocks[k_][0].distance(plaza)); reserved[k_] = "church"
per_d = {}
for k_ in sorted(okb, key=lambda k_: all_blocks[k_][0].distance(big_roads) + rng.uniform(0, 12)):
    d_ = all_blocks[k_][2]
    if k_ in reserved or per_d.get(d_, 0) >= 2: continue
    if any(all_blocks[k_][0].distance(all_blocks[j][0]) < 90 for j in reserved): continue
    reserved[k_] = "church" if per_d.get(d_, 0) == 1 else "hall"; per_d[d_] = per_d.get(d_, 0) + 1
buildings, bdist, landmarks, lm_blocks = [], [], [], []
for k_, (blk, ci, d_, sc) in enumerate(all_blocks):
    if k_ in reserved:
        fp = None
        for sc_ in (1.0, 0.88, 0.76, 0.64, 0.52):
            cand_ = church(blk, sc_) if reserved[k_] == "church" else hall(blk, sc_)
            if cand_.geom_type == "Polygon" and blk.buffer(-1.0).contains(cand_): fp = cand_; break
        if fp is not None and fp.area > 120: landmarks.append(fp); lm_blocks.append(blk); continue
    new_b = ([q.buffer(-0.3, join_style=2) for q in ([blk] if blk.area < 230 else bisect(blk, 0)) if q.area > 60] if blk.area < 420 else edge_buildings(blk, sc))
    buildings += new_b; bdist += [d_] * len(new_b)
keepm = [k_ for k_, b in enumerate(buildings) if b.geom_type == "Polygon" and b.area > 45]
buildings = [buildings[k_] for k_ in keepm]; bdist = [bdist[k_] for k_ in keepm]
N_TARGET = N_TARGET - len(landmarks)             # landmarks are part of the town's count
buildings = [b for b in buildings if b.geom_type == "Polygon" and b.area > 45]
# ================= EXACT COUNT: more are made than needed; the town keeps the best-placed and the rest never existed ====
made = len(buildings)
base = np.array([cost_at((b.centroid.x, b.centroid.y)) for b in buildings])
core_edge = np.sort(base)[int(N_TARGET * 0.62)]                 # the inner 62% of the town is solid
over = np.clip(base - core_edge, 0, None)
if WALLED:
    from shapely import contains_xy as _cx
    ins = _cx(wall_poly, np.array([b.centroid.x for b in buildings]), np.array([b.centroid.y for b in buildings])); base = np.where(ins, base * 0.2, base); over = np.where(ins, 0, over)
score = base + over * rng.exponential(1.4, len(buildings))      # beyond that, keeping a building is increasingly a matter of luck
keep_idx = np.argsort(score)[:N_TARGET]
buildings = [buildings[i] for i in keep_idx]; bdist = [bdist[i] for i in keep_idx]

built = unary_union([b.buffer(22) for b in buildings]).buffer(10)
trimmed = []
for m in main_streets:
    x = m.intersection(built); parts = [q for q in (x.geoms if hasattr(x, 'geoms') else [x]) if q.geom_type == 'LineString' and not q.is_empty and len(q.coords) > 1]
    parts = [q for q in parts if Point(q.coords[0]).distance(Point(m.coords[0])) < 3]
    if parts and parts[0].length > 60: trimmed.append(parts[0])
main_streets = trimmed
# streets are not made, they are found: whatever lies between blocks, wherever buildings stand on it
near_b = unary_union([b.buffer(7.5) for b in buildings] + [l_.buffer(14) for l_ in landmarks]).buffer(6).buffer(-6)
ward_ground = unary_union([w_[0].buffer(GAP / 2 + 0.6, join_style=2) for w_ in wards])
block_ground = unary_union([b_[0] for b_ in all_blocks])
streets_found = ward_ground.difference(block_ground).intersection(near_b)
pass_u = unary_union([p_ for p_ in passages if p_.geom_type == "Polygon" and p_.area > 8]).intersection(near_b) if passages else None
if pass_u is not None and not pass_u.is_empty: streets_found = unary_union([streets_found, pass_u])
if wall_parts: streets_found = streets_found.difference(unary_union([wp.buffer(4.5, cap_style=2) for wp in wall_parts]))
streets_found = streets_found.buffer(-0.5).buffer(0.5)
# ---- checks: is any house outside its block, on a street, or on another house?
from shapely.strtree import STRtree as _T
tree_ = _T(buildings); n_ov = 0
for i_, b_ in enumerate(buildings):
    for j_ in tree_.query(b_):
        if j_ > i_ and b_.intersection(buildings[j_]).area > 1.0: n_ov += 1
on_street = sum(1 for b_ in buildings if b_.intersection(streets_found).area > 1.0)
print("CHECK overlapping pairs:", n_ov, "| houses on a street:", on_street)
# ================= draw, in the manner of the reference maps =================
fig, ax = plt.subplots(figsize=(13, 13), dpi=int(os.environ.get('DPI', 110))); ax.set_facecolor("#bfbfb5"); fig.patch.set_facecolor("#bfbfb5")
def fill(geom, col, z, **kw):
    for q in (geom.geoms if hasattr(geom, "geoms") else [geom]):
        if q.geom_type == "Polygon": ax.add_collection(PolyCollection([np.array(q.exterior.coords)], facecolor=col, edgecolor=kw.get("ec", "none"), linewidth=kw.get("lw", 0), zorder=z))
if water is not None: fill(water, "#8d9a9c", 1, ec="#3f322c", lw=0.6)
from matplotlib.path import Path as MPath
from matplotlib.patches import PathPatch
def fill_holes(geom, col, z):
    for q in (geom.geoms if hasattr(geom, "geoms") else [geom]):
        if q.geom_type != "Polygon" or q.is_empty: continue
        verts, codes = [], []
        for ring_ in [q.exterior] + list(q.interiors):
            c_ = np.array(ring_.coords); verts += list(c_); codes += [MPath.MOVETO] + [MPath.LINETO] * (len(c_) - 2) + [MPath.CLOSEPOLY]
        ax.add_patch(PathPatch(MPath(verts, codes), facecolor=col, edgecolor="none", zorder=z))
fill_holes(streets_found, os.environ.get("STREETCOL", "#e1dbd5"), 2.6)
for m in main_streets: fill(m.buffer(MAIN / 2 - 1.2), "#e1dbd5", 2.8, ec="#3f322c", lw=0.5)
for h in highways: fill(h.buffer(HW / 2 - 1), "#e1dbd5", 3, ec="#3f322c", lw=0.7)
for hb in harbour: fill(hb, "#e1dbd5", 3.2, ec="#3f322c", lw=0.7)
for b in bridges: fill(b.buffer(HW / 2 + 0.5, cap_style=2), "#e1dbd5", 3.5, ec="#3f322c", lw=0.9)
ax.add_collection(PolyCollection([np.array(b.exterior.coords) for b in buildings], facecolor=[DCHAR[d_ % len(DCHAR)][1] for d_ in bdist], edgecolor="#3f322c", linewidth=0.45, zorder=5))
for lm in landmarks: fill(lm, "#3d3d3d", 6, ec="#1f1b18", lw=0.6)
fill(plaza, "#e1dbd5", 3.6, ec="#3f322c", lw=0.6)
if castle is not None:
    fill(castle, "#e1dbd5", 4, ec="#3d3d3d", lw=3.0)
    for x_, y_ in list(castle.exterior.coords)[:-1]: ax.plot(x_, y_, "o", ms=6.5, color="#3d3d3d", zorder=7)
    cc_ = np.array(castle.centroid.coords[0]); u_ = r_ca * 0.42
    kp = box(cc_[0] - u_, cc_[1] - u_ * 0.6, cc_[0] + u_, cc_[1] + u_ * 0.6).union(box(cc_[0] - u_ * 0.4, cc_[1] - u_ * 1.1, cc_[0] + u_ * 0.4, cc_[1] + u_ * 1.1))
    fill(affinity.rotate(kp, 25, origin=tuple(cc_)).intersection(castle.buffer(-5)), "#3d3d3d", 6)
for wp in wall_parts:
    seg_ = wp
    for g_ in gates: seg_ = seg_.difference(g_.buffer(7))
    for q in (seg_.geoms if hasattr(seg_, "geoms") else [seg_]):
        xy = np.array(q.coords); ax.plot(xy[:, 0], xy[:, 1], color="#3d3d3d", lw=3.4, solid_capstyle="butt", zorder=7)
wu_ = unary_union(wall_parts) if wall_parts else None
for tw in towers:
    if wu_ is not None and wu_.distance(Point(tw)) < 1 and (water is None or water.distance(Point(tw)) > 8): ax.plot(tw[0], tw[1], "o", ms=6.5, color="#3d3d3d", zorder=7.1)
for g_ in gates: ax.plot(g_.x, g_.y, "s", ms=8.5, mfc="#e1dbd5", mec="#3d3d3d", mew=2.2, zorder=8)
e = max(R * 2.0, 330); ax.set_xlim(-e, e); ax.set_ylim(e, -e); ax.set_aspect("equal"); ax.axis("off")
ax.plot([-e * .95, -e * .95 + 100], [e * .95, e * .95], color="#3f322c", lw=2); ax.text(-e * .95 + 110, e * .955, "100 m", fontsize=11, color="#3f322c")
ax.text(-e * .97, -e * .94, S["title"], fontsize=15, weight="bold", color="#3f322c")
ax.text(-e * .97, -e * .885, f"{len(wards)} wards · {made} buildings made, {len(buildings) + len(landmarks)} kept incl. {len(landmarks)} landmarks (exact count)", fontsize=11, color="#3f322c")
fig.savefig(out, bbox_inches="tight")
ar = sorted(b.area for b in buildings); print(name, len(landmarks), 'landmarks', len(gates), 'gates', len(wards), "wards", made, "made", len(buildings), "kept | area p10/med/p90", round(ar[len(ar)//10]), round(ar[len(ar)//2]), round(ar[len(ar)*9//10]))
