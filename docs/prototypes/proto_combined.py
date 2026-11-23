"""Reference prototype: roads -> wards -> buildings.
1 roads first (highway through, arterials branching, quay)   2 the ground the town needs, hugging the roads
3 wards = the pieces the roads cut that ground into, big ones split by ordinary streets
4 every ward cut in two again and again until the pieces are building-sized (alleys on early cuts)
No thinning, no leftover countryside: the ground is sized to the buildings."""
import sys, math
import numpy as np
from scipy.ndimage import gaussian_filter
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union
from shapely import affinity
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection

seed = int(sys.argv[1]) if len(sys.argv) > 1 else 7
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/rv/proto_combined.png"
BUILDINGS = int(sys.argv[3]) if len(sys.argv) > 3 else 1825
rng = np.random.default_rng(seed)
HIGHWAY, ARTERIAL, STREET, ALLEY = 10.0, 7.0, 4.5, 2.4
MEAN_LOT, FILL = 200.0, 0.80
TARGET_AREA = BUILDINGS * MEAN_LOT / FILL

def ray(b, r):
    a = math.radians(b); return np.array([math.sin(a) * r, -math.cos(a) * r])
def chaikin(p, n=3):
    p = np.asarray(p, float)
    for _ in range(n):
        q = [p[0]]
        for a, b in zip(p[:-1], p[1:]): q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        q.append(p[-1]); p = np.array(q)
    return p
def wander(p0, p1, amp, k=6):
    p0, p1 = np.array(p0, float), np.array(p1, float); d = p1 - p0
    n = np.array([-d[1], d[0]]) / np.linalg.norm(d); ts = np.linspace(0, 1, k + 2)
    off = gaussian_filter(rng.normal(0, amp, k + 2) * np.sin(np.pi * ts), 1.0)
    return chaikin([p0 + d * t + n * o for t, o in zip(ts, off)])

# water
ys = np.linspace(-1500, 1500, 300)
xs = 300 + 110 * np.sin(ys / 190 + rng.uniform(0, 6)) + 55 * np.sin(ys / 77 + rng.uniform(0, 6)) + ys * 0.12
river = LineString(np.c_[xs, ys]); RW = 26; water = river.buffer(RW / 2)

# 1 roads
R = math.sqrt(TARGET_AREA / math.pi)
hw = LineString(np.vstack([wander(ray(227, R * 3), (0, 0), 55)[:-1], wander((0, 0), ray(61, R * 3), 55)]))
s_mid = hw.project(Point(0, 0)); branches = []; s = s_mid - R * 1.25; side = 1
while s < s_mid + R * 1.25:
    p, q = hw.interpolate(s), hw.interpolate(s + 5)
    t = np.array([q.x - p.x, q.y - p.y]); t /= np.linalg.norm(t); n = np.array([-t[1], t[0]]) * side
    reach = (R * 1.5 - 0.7 * abs(s - s_mid)) * rng.uniform(0.75, 1.1)
    d = n + t * rng.normal(0, 0.3); end = np.array([p.x, p.y]) + d / np.linalg.norm(d) * reach
    branches.append(LineString(wander((p.x, p.y), end, 35))); s += rng.uniform(130, 220); side = -side
quays = [river.parallel_offset(RW / 2 + 8, sd) for sd in ("left", "right")]
from shapely.ops import substring
def tangent(line, at):
    p, q = line.interpolate(max(at - 8, 0)), line.interpolate(min(at + 8, line.length))
    t = np.array([q.x - p.x, q.y - p.y]); return t / np.linalg.norm(t)
def bridge_at(X, toward):
    """A short bridge square to the river at X; A is the end on the side of the point 'toward'."""
    t = tangent(river, river.project(X)); n = np.array([-t[1], t[0]]); c = np.array([X.x, X.y]); h = RW / 2 + 7
    A, B = c - n * h, c + n * h
    if np.hypot(*(A - toward)) > np.hypot(*(B - toward)): A, B = B, A
    return A, B
bridges = []
# the highway crosses once, square to the river
X = hw.intersection(river); X = min(X.geoms, key=lambda p: p.distance(Point(0, 0))) if hasattr(X, "geoms") else X
sx = hw.project(X); pre = substring(hw, 0, sx - 85); post = substring(hw, sx + 85, hw.length)
A, B = bridge_at(X, np.array(pre.coords[-1]))
hw = LineString(np.vstack([np.array(pre.coords), A, B, np.array(post.coords)])); bridges.append(LineString([A, B]))
s_mid = hw.project(Point(0, 0))
# arterials stop at the bank
reach_w = water.buffer(11)
for i, br in enumerate(branches):
    if br.intersects(reach_w):
        hit = br.intersection(reach_w.exterior); pts_ = list(hit.geoms) if hasattr(hit, "geoms") else [hit]
        d0 = min(br.project(p) for p in pts_ if p.geom_type == "Point")
        branches[i] = substring(br, 0, max(d0, 20))
# one more bridge, with its own arterial, away from the first
rs = river.project(X); cands = [rs - 260, rs + 260]
Y = min((river.interpolate(c) for c in cands), key=lambda p: p.distance(Point(0, 0)))
near = hw.interpolate(hw.project(Y)); A2, B2 = bridge_at(Y, np.array([0.0, 0.0]))
bridges.append(LineString([A2, B2]))
start = hw.interpolate(hw.project(Point(A2)) ); 
branches.append(LineString(wander((start.x, start.y), A2, 18)))
out_dir = (B2 - A2) / np.hypot(*(B2 - A2))
branches.append(LineString(wander(B2, B2 + out_dir * R * 0.75 + rng.normal(0, 40, 2), 22)))

# 2 ground: cheapest cells first until the area is enough
g = 12.0; ext = R * 2.4
gx, gy = np.meshgrid(np.arange(-ext, ext, g), np.arange(-ext, ext, g))
P = np.c_[gx.ravel(), gy.ravel()]
def dist_to(line, P):
    c = np.array(line.coords); best = np.full(len(P), 1e9)
    for a, b in zip(c[:-1], c[1:]):
        ab = b - a; t = np.clip(((P - a) @ ab) / (ab @ ab + 1e-9), 0, 1)
        best = np.minimum(best, np.hypot(*(P - (a + t[:, None] * ab)).T))
    return best
dh = dist_to(hw, P); db = np.min([dist_to(b, P) for b in branches], axis=0); dw = dist_to(river, P)
along = np.abs(np.array([hw.project(Point(p)) for p in P[::1]]) - s_mid) if len(P) < 60000 else np.hypot(*P.T)
noise = gaussian_filter(rng.normal(0, 1, gx.shape), 6).ravel(); noise = noise / np.abs(noise).max() * 70
cost = dh + 0.45 * along + 0.8 * np.minimum(db, 200) + noise
cost[dw < RW / 2 + 4] = 1e9
k = int(TARGET_AREA * 1.12 / (g * g)); thr = np.sort(cost)[k]
cells = [box(x - g / 2, y - g / 2, x + g / 2, y + g / 2) for (x, y), c in zip(P, cost) if c <= thr]
ground = unary_union(cells).buffer(28, join_style=1).buffer(-28, join_style=1).buffer(-10).buffer(10)
ground = max(ground.geoms, key=lambda q: q.area) if hasattr(ground, "geoms") else ground
ground = Polygon(ground.exterior)   # no holes

# arterials are trimmed back to the town once the ground is known; the highway runs on
def trim(line):
    x = line.intersection(ground.buffer(5))
    if x.is_empty: return None
    parts = [q for q in (x.geoms if hasattr(x, "geoms") else [x]) if q.geom_type == "LineString"]
    return max(parts, key=lambda q: q.length) if parts else None
branches = [t for t in (trim(b) for b in branches) if t is not None and t.length > 25]
# 3 wards: what the roads cut the ground into
cuts = unary_union([br.buffer(ARTERIAL / 2) for br in bridges] + [hw.buffer(HIGHWAY / 2)] + [b.buffer(ARTERIAL / 2) for b in branches] + [q.buffer(STREET / 2) for q in quays] + [water.buffer(6)])
faces = ground.difference(cuts)
faces = [f for f in (faces.geoms if hasattr(faces, "geoms") else [faces]) if f.area > 250]

def cut(poly, ratio, angle, gap, bend=0.0):
    mrr = poly.minimum_rotated_rectangle; c = np.array(mrr.exterior.coords)
    e1, e2 = c[1] - c[0], c[2] - c[1]
    a0, long_e = (c[0], e1) if np.hypot(*e1) >= np.hypot(*e2) else (c[1], e2)
    short_e = e2 if long_e is e1 else c[1] - c[0] if False else (e2 if np.hypot(*e1) >= np.hypot(*e2) else -e1)
    p1 = a0 + long_e * ratio
    ca, sa = math.cos(angle), math.sin(angle)
    nrm = np.array([-long_e[1], long_e[0]]); nrm = nrm / (np.hypot(*nrm) + 1e-9)
    d = np.array([nrm[0] * ca - nrm[1] * sa, nrm[1] * ca + nrm[0] * sa]) * 5000
    if bend > 0:
        L = min(np.hypot(*e1), np.hypot(*e2)) * 0.75; u = d / 5000.0; v = np.array([-u[1], u[0]])
        ts = np.linspace(-1, 1, 7); off = rng.normal(0, bend * L, 7); off[0] = off[-1] = 0; off = gaussian_filter(off, 0.8)
        mid = chaikin([p1 + u * L * t + v * o for t, o in zip(ts, off)], 2)
        line = LineString(np.vstack([p1 - d, mid, p1 + d]))
    else:
        line = LineString([p1 - d, p1 + d])
    res = poly.difference(line.buffer(max(gap, 0.02) / 2, cap_style=2, join_style=1))
    return [q for q in (res.geoms if hasattr(res, "geoms") else [res]) if q.geom_type == "Polygon" and q.area > 6]

def split_wards(poly, depth=0):
    lim = rng.uniform(6500, 15000)
    if poly.area < lim or depth > 8: return [poly]
    hs = cut(poly, rng.uniform(0.36, 0.64), rng.normal(0, 0.2), STREET, bend=0.07)
    if len(hs) < 2: return [poly]
    return [w for h in hs for w in split_wards(h, depth + 1)]
wards = [w for f in faces for w in split_wards(f)]

# 4 buildings
def cut_block(poly, min_sq, grid_chaos, size_chaos, empty_prob, alley=True, depth=0):
    spread = 0.8 * grid_chaos; ratio = (1 - spread) / 2 + rng.random() * spread
    ang = (rng.random() - 0.5) * math.pi / 6 * grid_chaos * (0 if poly.area < min_sq * 4 else 1)
    hs = cut(poly, ratio, ang, ALLEY if alley else 0)
    if len(hs) < 2 or depth > 40: return [poly]
    res = []
    for h in hs:
        if h.area < min_sq * 2 ** (4 * size_chaos * (rng.random() - 0.5)):
            if rng.random() >= empty_prob and h.area > 25: res.append(h)
        else:
            res += cut_block(h, min_sq, grid_chaos, size_chaos, empty_prob, h.area > min_sq / (rng.random() * rng.random() + 1e-9), depth + 1)
    return res

# districts: chunks bounded by roads and river
cents = np.array([[w.centroid.x, w.centroid.y] for w in wards])
ds = [cents[np.argmin(np.hypot(*cents.T))]]
for _ in range(5):
    dmin = np.min([np.hypot(*(cents - q).T) for q in ds], axis=0); ds.append(cents[np.argmax(dmin)])
barriers = [(hw, 150)] + [(b, 110) for b in branches] + [(river, 400)]
wgt = np.ones(len(ds)); areas = np.array([w.area for w in wards])
def assign():
    out = []
    for p in cents:
        best, bd = 0, 1e9
        for kk, q in enumerate(ds):
            seg = LineString([p, q]); d = (seg.length + sum(pen for l, pen in barriers if seg.crosses(l))) * wgt[kk]
            if d < bd: best, bd = kk, d
        out.append(best)
    return np.array(out)
for _ in range(12):
    dist_of = assign()
    share = np.array([areas[dist_of == kk].sum() for kk in range(len(ds))]) / areas.sum()
    wgt *= (share * len(ds) + 0.25) ** 0.35
dist_of = assign()
palette = ["#e6b8af", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4"]
CHAR = [((330, 380), 0.05), ((200, 420), 0.02), ((200, 380), 0.02), ((470, 380), 0.06), ((150, 250), 0.01), ((200, 380), 0.02)]

builds, cols, n = [], [], 0
# the edge frays: the last wards to be taken are looser
def cost_at(p):
    pt = Point(p); return hw.distance(pt) + 0.45 * abs(hw.project(pt) - s_mid) + 0.8 * min(min(b.distance(pt) for b in branches), 200)
wc = np.array([cost_at(c) for c in cents]); loose_from = np.quantile(wc, 0.80)
for wi, (w, c) in enumerate(zip(wards, cents)):
    d = int(dist_of[wi]); (m0, m1), ep = CHAR[d]
    loose = wc[wi] >= loose_from
    if loose: ep = 0.22 + 0.25 * (wc[wi] - loose_from) / (wc.max() - loose_from + 1e-9)
    for b in cut_block(w.simplify(0.6), m0 + m1 * rng.random() * rng.random(), 0.5 + 0.3 * rng.random(), 0.7, ep):
        if loose:
            b = b.buffer(-rng.uniform(0.6, 2.2), join_style=2)
            if b.is_empty or b.geom_type != "Polygon" or b.area < 30: continue
        builds.append(np.array(b.exterior.coords)); cols.append(palette[d]); n += 1

fig, ax = plt.subplots(figsize=(15, 15), dpi=110); ax.set_facecolor("#f6f4ee"); fig.patch.set_facecolor("#f6f4ee")
ax.add_collection(PolyCollection([np.array(water.exterior.coords)], facecolor="#a9cbe8", edgecolor="none", zorder=1))
ax.add_collection(PolyCollection([np.array(ground.buffer(4).exterior.coords)], facecolor="#e2ded3", edgecolor="none", zorder=2))
for line, wd, col in [(hw, HIGHWAY, "#d2bd94")] + [(b, ARTERIAL, "#d8c9a8") for b in branches]:
    poly = line.buffer(wd / 2)
    ax.add_collection(PolyCollection([np.array(poly.exterior.coords)], facecolor=col, edgecolor="none", zorder=2.5))
ax.add_collection(PolyCollection([np.array(water.exterior.coords)], facecolor="#a9cbe8", edgecolor="none", zorder=2.6))
ax.add_collection(PolyCollection([np.array(w.exterior.coords) for w in wards], facecolor="#ebe7dc", edgecolor="none", zorder=3))
for br in bridges:
    ax.add_collection(PolyCollection([np.array(br.buffer(5, cap_style=2).exterior.coords)], facecolor="#9a8f7d", edgecolor="#5c5548", linewidth=0.8, zorder=5))
ax.add_collection(PolyCollection(builds, facecolor=cols, edgecolor="#3a3a36", linewidth=0.5, zorder=4))
e = R * 2.05; ax.set_xlim(-e, e); ax.set_ylim(e, -e); ax.set_aspect("equal"); ax.axis("off")
ax.plot([-e * .95, -e * .95 + 100], [e * .95, e * .95], color="#23272e", lw=2); ax.text(-e * .95 + 110, e * .955, "100 m", fontsize=11)
ax.text(-e * .97, -e * .95, f"roads → wards → buildings · seed {seed} · {len(wards)} wards · {n} buildings (target {BUILDINGS})", fontsize=14, weight="bold")
fig.savefig(out, bbox_inches="tight"); print(len(wards), "wards", n, "buildings", round(ground.area / 1e4, 1), "ha")
