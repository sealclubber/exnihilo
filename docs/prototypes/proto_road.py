"""Reference prototype for Phase 6D.2 (not production code; Python + scipy + shapely + matplotlib).
Road first: highway -> arterials branching off it -> ground taken by closeness to roads -> Wards oriented to roads -> jittered brick lattice seeds ->
Voronoi blocks -> through-street chaining + smoothing + domain warp -> strip lots."""
import sys, math
import numpy as np
from scipy.spatial import Voronoi, cKDTree
from scipy.ndimage import gaussian_filter
from shapely.geometry import Polygon, LineString, Point, MultiPolygon, box
from shapely.ops import unary_union
from shapely import affinity
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection

seed = int(sys.argv[1]) if len(sys.argv) > 1 else 7
out = sys.argv[2] if len(sys.argv) > 2 else "/tmp/rv/proto.png"
rng = np.random.default_rng(seed)
R = 520.0          # rough town radius, m
A, B = 46.0, 105.0  # block depth across, length along


def smooth_line(pts, n=4):
    pts = np.asarray(pts, float)
    for _ in range(n):  # Chaikin, ends kept
        q = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        q.append(pts[-1])
        pts = np.array(q)
    return pts


def wander(p0, p1, amp, k=6):
    p0, p1 = np.array(p0, float), np.array(p1, float)
    d = p1 - p0
    nrm = np.array([-d[1], d[0]]) / np.linalg.norm(d)
    ts = np.linspace(0, 1, k + 2)
    off = rng.normal(0, amp, k + 2) * np.sin(np.pi * ts)
    off = gaussian_filter(off, 1.0)
    return smooth_line([p0 + d * t + nrm * o for t, o in zip(ts, off)])


# --- water: a meandering river east of the centre
ys = np.linspace(-1100, 1100, 60)
xs = 330 + 110 * np.sin(ys / 190.0 + rng.uniform(0, 6)) + 60 * np.sin(ys / 77.0 + rng.uniform(0, 6)) + ys * 0.12
river = LineString(smooth_line(np.c_[xs, ys], 2))
river_w = 26.0
water = river.buffer(river_w / 2)

# --- roads: one arterial through the centre, local roads in the gaps, a road each side of the river
def ray(bearing, r):
    a = math.radians(bearing)
    return np.array([math.sin(a) * r, -math.cos(a) * r])

roads = []  # (kind, LineString)
hw = LineString(np.vstack([wander(ray(227, R * 1.7), (0, 0), 55)[:-1], wander((0, 0), ray(61, R * 1.7), 55)]))
roads.append(("highway", hw))
# arterials branch off the highway, alternating sides, older and longer near the middle
branches = []
s_mid = hw.project(Point(0, 0)); s = s_mid - 430; side = 1
while s < s_mid + 430:
    p = hw.interpolate(s); q = hw.interpolate(s + 5)
    t = np.array([q.x - p.x, q.y - p.y]); t /= np.linalg.norm(t)
    n = np.array([-t[1], t[0]]) * side
    reach = (560 - 0.75 * abs(s - s_mid)) * rng.uniform(0.75, 1.1)
    d = n * math.cos(0.35 * rng.normal()) + t * rng.normal(0, 0.3)
    end = np.array([p.x, p.y]) + d / np.linalg.norm(d) * reach
    line = LineString(wander((p.x, p.y), end, 40))
    # stop at the river unless this is the one that bridges it
    branches.append(line); roads.append(("arterial", line))
    s += rng.uniform(120, 210); side = -side
n_main = len(roads)
for sd in (1, -1):
    roads.append(("street", river.parallel_offset(river_w / 2 + 9, "left" if sd > 0 else "right")))

def ground_cost(p):
    pt = Point(p)
    dh = hw.distance(pt)
    db = min(l.distance(pt) for l in branches)
    along = abs(hw.project(pt) - s_mid)
    return 1.0 * dh + 0.45 * along + 0.8 * min(db, 200) + 30 * math.sin(p[0] / 130.0 + seed) * math.cos(p[1] / 170.0)

# --- wards: coarse cells, each with a grain taken from the nearest road
ward_pts = []
for _ in range(4000):
    p = rng.uniform(-R * 1.5, R * 1.5, 2)
    if all(np.hypot(*(p - q)) > 200 for q in ward_pts):
        ward_pts.append(p)
ward_pts = np.array(ward_pts)
ward_tree = cKDTree(ward_pts)

def road_dir(p):
    pt = Point(p)
    best = min(roads, key=lambda kl: kl[1].distance(pt))[1]
    s = best.project(pt)
    a, b = best.interpolate(max(s - 15, 0)), best.interpolate(min(s + 15, best.length))
    return math.atan2(b.y - a.y, b.x - a.x)

ward_ang = np.array([road_dir(p) + rng.normal(0, 0.18) for p in ward_pts])

# --- block seeds: a brick lattice per ward, jittered, in the ward's grain
seeds = []
for w, (c, th) in enumerate(zip(ward_pts, ward_ang)):
    ca, sa = math.cos(th), math.sin(th)
    a = A * rng.uniform(0.85, 1.3)
    b = B * rng.uniform(0.75, 1.35)
    for r_i, v in enumerate(np.arange(-330, 330, a)):
        shift = (r_i % 2) * b / 2 + rng.uniform(-0.15, 0.15) * b
        for u in np.arange(-330, 330, b):
            uu = u + shift + rng.normal(0, b * 0.16)
            vv = v + rng.normal(0, a * 0.10)
            p = c + np.array([uu * ca - vv * sa, uu * sa + vv * ca])
            if ward_tree.query(p)[1] == w:
                seeds.append(p)
seeds = np.array(seeds)

# keep seeds away from road centre lines and water, then add mirrored pairs along roads
road_union = unary_union([l for k, l in roads])
keep = [p for p in seeds if road_union.distance(Point(p)) > 20 and water.distance(Point(p)) > 22]
pairs = []
for kind, l in roads:
    off = 23.0
    s = rng.uniform(0, 40)
    while s < l.length:
        a, b = l.interpolate(s), l.interpolate(min(s + 1, l.length))
        t = np.array([b.x - a.x, b.y - a.y]); t /= (np.linalg.norm(t) + 1e-9)
        n = np.array([-t[1], t[0]])
        base = np.array([a.x, a.y])
        j = rng.uniform(-8, 8)
        pairs.append(base + n * off + t * j)
        pairs.append(base - n * off + t * (j + rng.uniform(-18, 18)))
        s += rng.uniform(34, 70)
seeds = np.array(keep + pairs)
# drop near-duplicates
tree = cKDTree(seeds)
drop = set()
for i, j in tree.query_pairs(14):
    drop.add(max(i, j))
seeds = np.array([p for i, p in enumerate(seeds) if i not in drop])

# --- which cells are town
cost = np.array([ground_cost(p) for p in seeds])
in_water = np.array([water.distance(Point(p)) < 6 for p in seeds])
target_blocks = 330
order = np.argsort(cost + in_water * 1e6)
town = np.zeros(len(seeds), bool)
town[order[:target_blocks]] = True
town &= ~in_water
cost_sorted = np.sort(cost[town])
# districts: chunks bounded by the highway, the arterials and the river
tpts = seeds[town]
dseeds = [tpts[np.argmin(cost[town])]]
for _ in range(6):
    dmin = np.min([np.hypot(*(tpts - q).T) for q in dseeds], axis=0)
    dseeds.append(tpts[np.argmax(dmin * (1 + 0.0 * dmin))])
barriers = [(hw, 140)] + [(l, 110) for l in branches] + [(river, 400)]
def district_of(p):
    best, bd = 0, 1e9
    for k, q in enumerate(dseeds):
        seg = LineString([p, q]); d = seg.length
        for l, pen in barriers:
            if seg.crosses(l): d += pen
        if d < bd: best, bd = k, d
    return best
palette = ["#e6b8af", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#d5a6bd"]

vor = Voronoi(seeds)
V = vor.vertices.copy()

# --- gentle warp of everything, so nothing stays ruler-straight
def noise_field(scale, amp, s):
    r = np.random.default_rng(s)
    g = gaussian_filter(r.normal(0, 1, (64, 64)), 3.0)
    g = g / np.abs(g).max() * amp
    def f(p):
        ix = np.clip(((p[:, 0] + 1800) / 3600 * 63), 0, 62.999); iy = np.clip(((p[:, 1] + 1800) / 3600 * 63), 0, 62.999)
        x0, y0 = ix.astype(int), iy.astype(int); fx, fy = ix - x0, iy - y0
        return (g[y0, x0] * (1 - fx) * (1 - fy) + g[y0, x0 + 1] * fx * (1 - fy) + g[y0 + 1, x0] * (1 - fx) * fy + g[y0 + 1, x0 + 1] * fx * fy)
    return f

# --- street graph from ridges touching town cells
edges = {}
for (p, q), (a, b) in zip(vor.ridge_points, vor.ridge_vertices):
    if a < 0 or b < 0:
        continue
    if not (town[p] or town[q]):
        continue
    if in_water[p] or in_water[q]:
        if not (town[p] or town[q]):
            continue
    edges[(min(a, b), max(a, b))] = (p, q)
nbr = {}
for a, b in edges:
    nbr.setdefault(a, []).append(b); nbr.setdefault(b, []).append(a)

# chain edges into through streets: at each junction pair the two straightest
def ang(u, v, w):
    d1, d2 = V[v] - V[u], V[w] - V[v]
    c = np.dot(d1, d2) / (np.linalg.norm(d1) * np.linalg.norm(d2) + 1e-9)
    return math.degrees(math.acos(np.clip(c, -1, 1)))
partner = {}
for v, ns in nbr.items():
    cands = sorted((ang(u, v, w), u, w) for i, u in enumerate(ns) for w in ns[i + 1:])
    used = set()
    for dev, u, w in cands:
        if dev < 40 and u not in used and w not in used:
            partner[(u, v)] = w; partner[(w, v)] = u; used |= {u, w}

# smooth: pull each junction towards the line of the through street passing it
for it in range(6):
    newV = V.copy()
    for v, ns in nbr.items():
        acc, n = np.zeros(2), 0
        for u in ns:
            w = partner.get((u, v))
            if w is not None and u < w:
                acc += (V[u] + V[w]) / 2; n += 1
        if n:
            newV[v] = 0.55 * V[v] + 0.45 * acc / n
    V = newV

# trace chains
seen, chains = set(), []
for (a, b) in edges:
    if (a, b) in seen:
        continue
    chain = [a, b]; seen.add((a, b))
    for direction in (0, 1):
        while True:
            u, v = chain[-2], chain[-1]
            w = partner.get((u, v))
            if w is None or (min(v, w), max(v, w)) in seen:
                break
            seen.add((min(v, w), max(v, w))); chain.append(w)
        chain.reverse()
    chains.append(chain)

# --- blocks and lots
fig, ax = plt.subplots(figsize=(15, 15), dpi=110)
ax.set_facecolor("#f6f4ee"); fig.patch.set_facecolor("#f6f4ee")
ax.add_collection(PolyCollection([np.array(water.exterior.coords)], facecolor="#a9cbe8", edgecolor="none", zorder=1))

lot_polys, lot_cols, block_polys = [], [], []
road_cut = unary_union([hw.buffer(7)] + [l.buffer(4.5) for l in branches])
dcentres = np.array([ray(b, r) for b, r in ((0, 0), (20, 300), (110, 330), (200, 330), (290, 320), (150, 120))])
for i in np.where(town)[0]:
    reg = vor.regions[vor.point_region[i]]
    if -1 in reg or len(reg) < 3:
        continue
    poly = Polygon(V[reg])
    if not poly.is_valid:
        poly = poly.buffer(0)
    blk = poly.buffer(-4.2, join_style=1).buffer(1.2, join_style=1).difference(water.buffer(5)).difference(road_cut)
    if blk.is_empty or blk.area < 250:
        continue
    if isinstance(blk, MultiPolygon):
        blk = max(blk.geoms, key=lambda g: g.area)
    block_polys.append(blk)
    rank = float(np.searchsorted(cost_sorted, cost[i])) / target_blocks
    col = palette[district_of(seeds[i])]
    d = 0 if rank < 0.45 else 3
    # grain of the block = its longest side
    mrr = blk.minimum_rotated_rectangle
    c = np.array(mrr.exterior.coords)
    e1, e2 = c[1] - c[0], c[2] - c[1]
    long_e = e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2
    th = math.atan2(long_e[1], long_e[0])
    rot = affinity.rotate(blk, -math.degrees(th), origin=(0, 0))
    minx, miny, maxx, maxy = rot.bounds
    depth = maxy - miny
    rows = [(miny, maxy)] if depth < 24 else [(miny, miny + depth * rng.uniform(0.44, 0.56)), None]
    if rows[-1] is None:
        rows[-1] = (rows[0][1], maxy)
    dense = d in (0, 5)
    if not dense and rng.random() < 0.10: continue
    for (y0, y1) in rows:
        x = minx
        while x < maxx:
            wdt = rng.uniform(5.5, 9.5) if dense else rng.uniform(7, 15)
            if rng.random() < 0.08:
                wdt *= 2.2
            skew = rng.normal(0, 0.9)
            cell = Polygon([(x, y0), (x + wdt, y0), (x + wdt + skew, y1), (x + skew, y1)])
            x += wdt
            if not dense and rng.random() < 0.12:
                continue
            piece = rot.intersection(cell)
            if piece.is_empty or piece.area < 22:
                continue
            piece = affinity.rotate(piece, math.degrees(th), origin=(0, 0))
            for g in (piece.geoms if hasattr(piece, "geoms") else [piece]):
                if g.geom_type == "Polygon" and g.area > 22:
                    lot_polys.append(np.array(g.exterior.coords)); lot_cols.append(col)

town_shape = unary_union(block_polys).buffer(9).buffer(-3)
for g in (town_shape.geoms if hasattr(town_shape, "geoms") else [town_shape]):
    ax.add_collection(PolyCollection([np.array(g.exterior.coords)], facecolor="#dcd8ce", edgecolor="none", zorder=2))
ax.add_collection(PolyCollection([np.array(b.exterior.coords) for b in block_polys], facecolor="#efece4", edgecolor="none", zorder=3))
ax.add_collection(PolyCollection(lot_polys, facecolor=lot_cols, edgecolor="#23272e", linewidth=0.25, alpha=0.95, zorder=4))
# main roads drawn over
for kind, l in roads[:n_main]:
    xy = np.array(l.coords)
    ax.plot(xy[:, 0], xy[:, 1], color="#d2bd94" if kind=='highway' else "#d8c9a8", lw=7.5 if kind=='highway' else 5, solid_capstyle="round", zorder=3.5)
ax.set_xlim(-720, 720); ax.set_ylim(720, -720); ax.set_aspect("equal"); ax.axis("off")
ax.plot([-690, -590], [690, 690], color="#23272e", lw=2); ax.text(-580, 695, "100 m", fontsize=11)
ax.text(-700, -690, f"road first · seed {seed} · {len(block_polys)} blocks · {len(lot_polys)} lots", fontsize=14, weight="bold")
fig.savefig(out, bbox_inches="tight")
print(len(block_polys), "blocks", len(lot_polys), "lots", len(chains), "chains, longest", max(len(c) for c in chains))
