"""Village prototype (under ~1,000 people). No mesh, no wards, no districts: the road leads.
Order: 1 environment (water, pond)  2 the road from the map, plus lanes only as frontage is needed
3 anchors (green, church, manor, mill, landing, palisade) from the shrunken flags
4 plots outward from the centre, one house on each (a short terraced row at the centre of bigger villages)
5 fields, tracks and trees around it all.   Usage: proto_village.py <street|green|cross|shore> <buildings> <out.png> [seed]"""
import sys, math, os
import numpy as np
from scipy.ndimage import gaussian_filter
from shapely.geometry import Polygon, LineString, Point, box, MultiPolygon
from shapely.ops import unary_union, substring
from shapely import affinity
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection

shape, N, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 4
rng = np.random.default_rng(seed + N)
ROAD, LANE = 6.0, 3.6
BIG = 900.0

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
    p0, p1 = np.array(p0, float), np.array(p1, float); d = p1 - p0
    n = np.array([-d[1], d[0]]) / np.linalg.norm(d); ts = np.linspace(0, 1, k + 2)
    off = gaussian_filter(rng.normal(0, amp, k + 2), 1.0) * np.sin(np.pi * ts)
    return chaikin([p0 + d * t + n * o for t, o in zip(ts, off)], 4)
def tangent(line, s):
    p, q = line.interpolate(max(s - 4, 0)), line.interpolate(min(s + 4, line.length))
    t = np.array([q.x - p.x, q.y - p.y]); return t / (np.linalg.norm(t) + 1e-9)
def pt(line, s):
    return np.array(line.interpolate(s).coords[0])
def rect_at(c, u, v, w, d):       # corner c, along u for w, along v for d
    return Polygon([c, c + u * w, c + u * w + v * d, c + v * d])

# ---------------- 1 environment
b0 = rng.uniform(0, 180)
water = None; river = None; coast_dir = None; mill = None; landing = []; bridges = []
if shape == "street":
    a_, b_ = ray(b0 + 100, BIG), ray(b0 + 265, BIG); m = ray(b0 + 182, 95)
    nr = (b_ - a_); nr = np.array([-nr[1], nr[0]]) / np.linalg.norm(nr); sg = 1 if rng.random() < 0.5 else -1
    river = LineString(chaikin([a_, a_ * 0.5 + m * 0.5 + nr * sg * 150, m, m * 0.5 + b_ * 0.5 - nr * sg * 130, b_], 5))
    water = river.buffer(7)
if shape == "shore":
    cb = b0 + 90; c = ray(cb, 62); t = np.array([-ray(cb, 1)[1], ray(cb, 1)[0]])
    xs = np.linspace(-BIG, BIG, 12); off = gaussian_filter(rng.normal(0, 70, 12), 1.3); off -= off[len(off) // 2]
    pts_ = [c + t * x + ray(cb, 1) * o for x, o in zip(xs, off)]
    coast = LineString(chaikin(pts_, 4)); water = Polygon(list(coast.coords) + [pts_[-1] + ray(cb, 2000), pts_[0] + ray(cb, 2000)]); coast_dir = ray(cb, 1)

# ---------------- 2 roads
roads = []   # (line, width, kind)
main = LineString(np.vstack([wander(ray(b0, BIG), (0, 0), 30)[:-1], wander((0, 0), ray(b0 + 180 + rng.uniform(-12, 12), BIG), 30)]))
roads.append((main, ROAD, "road"))
if shape == "cross":
    x = LineString(np.vstack([wander(ray(b0 + 85, BIG), (0, 0), 28)[:-1], wander((0, 0), ray(b0 + 268, BIG), 28)])); roads.append((x, ROAD, "road"))
green = None; pond = None
if shape == "green":
    t0 = tangent(main, main.project(Point(0, 0))); n0 = np.array([-t0[1], t0[0]])
    L, W = (62, 30) if N < 110 else (92, 42)
    th = np.linspace(0, 2 * math.pi, 40, endpoint=False)
    g = np.c_[L * np.cos(th) * (1 + 0.08 * np.sin(3 * th + 1)), W * np.sin(th)]
    ang = math.atan2(t0[1], t0[0]); g = np.c_[g[:, 0] * math.cos(ang) - g[:, 1] * math.sin(ang), g[:, 0] * math.sin(ang) + g[:, 1] * math.cos(ang)]
    green = Polygon(g + n0 * (W + ROAD / 2 + 1))
    loop = LineString(green.buffer(LANE / 2 + 0.5).exterior.coords); roads.append((loop, LANE, "lane"))
    gc = np.array(green.centroid.coords[0]); pond = Point(gc + t0 * L * 0.35).buffer(9).intersection(green.buffer(-3))
if river is not None:   # a small bridge where the road meets the river
    X = main.intersection(river); X = min(X.geoms, key=lambda p: p.distance(Point(0, 0))) if hasattr(X, "geoms") else X
    if not X.is_empty: bridges.append(X)

# ---- bigger villages: the road forks and loops, and back lanes join up, so nothing reads as a comb
def clip_water(line):
    if water is None: return line
    c = line.difference(water.buffer(9)); parts = [q for q in (c.geoms if hasattr(c, "geoms") else [c]) if q.geom_type == "LineString" and q.length > 40]
    return max(parts, key=lambda q: q.length) if parts else None
def inland(n):
    return -n if (coast_dir is not None and np.dot(n, coast_dir) > 0) else n
s0m = main.project(Point(0, 0))
n_forks = 0 if N < 90 else 3 if N < 150 else 4
n_back = 0 if N < 120 else 1
BACK = 96.0
fork_sides = []
for k in range(n_forks):
    dirn = 1 if k % 2 == 0 else -1
    s = s0m + dirn * rng.uniform(15, 55) * (1 + 0.5 * (k // 2))
    p = pt(main, s); t = tangent(main, s) * dirn; side = 1 if (k // 2 + k) % 2 == 0 else -1
    n = inland(np.array([-t[1], t[0]]) * side)
    if green is not None and np.dot(n, np.array(green.centroid.coords[0]) - p) > 0: n = -n
    ang = math.radians(rng.uniform(26, 46)); d = t * math.cos(ang) + n * math.sin(ang)
    L = rng.uniform(170, 250)
    if rng.random() < 0.55:      # a loop: leaves the road and comes back to it farther out
        s2 = float(np.clip(s + dirn * L * 1.05, 5, main.length - 5)); e = pt(main, s2)
        mid = (p + e) / 2 + n * rng.uniform(62, 88)
        line = LineString(chaikin([p, p + d * 45, mid, e - tangent(main, s2) * dirn * 0 + n * 18, e], 4))
    else:
        line = LineString(wander(p, p + d * L + n * rng.uniform(10, 40), 14, k=3))
    line = clip_water(line)
    if line is not None: roads.append((line, LANE + 0.8, "lane")); fork_sides.append(n)
for k in range(n_back):
    side = 1 if k == 0 else -1
    t = tangent(main, s0m); n = inland(np.array([-t[1], t[0]]) * side)
    if k == 1 and coast_dir is not None: break
    if green is not None and np.dot(n, np.array(green.centroid.coords[0])) > 0:
        if k == 0: n = -n
        else: break
    ext = 70 + 0.75 * N * rng.uniform(0.85, 1.1)
    sa, sb = max(s0m - ext, 5), min(s0m + ext, main.length - 5)
    pts_ = []
    for ss in np.linspace(sa, sb, 14):
        tt = tangent(main, ss); nn = np.array([-tt[1], tt[0]]); nn = nn if np.dot(nn, n) > 0 else -nn
        pts_.append(pt(main, ss) + nn * BACK * rng.uniform(0.92, 1.1))
    line = LineString(np.vstack([pt(main, sa - 4), chaikin(pts_, 2), pt(main, sb + 4)]))
    line = clip_water(line)
    if line is not None: roads.append((line, LANE, "lane"))
if shape == "cross" and N >= 105:    # quarter links between the arms
    x = roads[1][0]; s0x = x.project(Point(0, 0))
    quarters = [(1, 1), (-1, -1), (1, -1), (-1, 1)][: (2 if N < 150 else 4)]
    for a_, b_ in quarters:
        r_ = rng.uniform(95, 135); p1 = pt(main, s0m + a_ * r_); p2 = pt(x, s0x + b_ * r_ * rng.uniform(0.85, 1.15))
        mid = (p1 + p2) / 2 * rng.uniform(1.05, 1.3)
        roads.append((LineString(chaikin([p1, mid, p2], 4)), LANE, "lane"))
PREBUILT = len(roads)

def add_lane(k):
    """A side lane off the nearest road, only when more frontage is needed."""
    base = roads[k % (2 if shape == "cross" else 1)][0]
    s = base.project(Point(0, 0)) + (1 if k % 2 == 0 else -1) * (55 + 60 * (k // 2)) * rng.uniform(0.85, 1.15)
    p = pt(base, s); t = tangent(base, s); n = np.array([-t[1], t[0]]) * (1 if (k // 2) % 2 == 0 else -1)
    if shape == "shore" and np.dot(n, coast_dir) > 0: n = -n
    if green is not None and green.distance(Point(p + n * 40)) < 25: n = -n
    d = n + t * rng.normal(0, 0.25); d /= np.linalg.norm(d)
    line = LineString(wander(p, p + d * rng.uniform(130, 210), 12, k=3))
    if water is not None:
        cut = line.difference(water.buffer(10)); cut = cut.geoms[0] if hasattr(cut, "geoms") else cut
        if cut.geom_type != "LineString" or cut.length < 50: return False
        line = cut
    roads.append((line, LANE, "lane")); return True

# ---------------- 3 anchors and 4 plots: cursors walk outward from the centre along every road side
occupied = []      # polygons nothing else may overlap
def free(poly):
    if water is not None and poly.intersects(water.buffer(3)): return False
    if green is not None and poly.intersects(green.buffer(LANE + 1)): return False
    for o in occupied:
        if poly.intersects(o) and poly.intersection(o).area > 0.5: return False
    for l, w, k in roads:
        if poly.intersection(l.buffer(w / 2)).area > 1.0: return False
    return True

plots, houses, sheds, special = [], [], [], []; used_roads = set(); since_lane = [0]
ROW = N >= 140
def make_plot(line, wd, s, side, direction, kind="house"):
    near = Point(pt(line, s)).distance(Point(0, 0))
    row = ROW and near < 70 and kind == "house"
    if kind == "church": w, d = 34, 40
    elif kind == "manor": w, d = 58, 62
    elif row: w, d = rng.uniform(7, 9.5), rng.uniform(24, 32)
    else: w, d = rng.uniform(13, 21), (rng.uniform(34, 58) if N < 105 else rng.uniform(30, 39))
    s1 = s + direction * w
    if s1 < 0 or s1 > line.length: return None, w
    sa, sb = min(s, s1), max(s, s1)
    ta, tb = tangent(line, sa), tangent(line, sb); na, nb = np.array([-ta[1], ta[0]]) * side, np.array([-tb[1], tb[0]]) * side
    off = wd / 2 + 0.8
    quad = Polygon([pt(line, sa) + na * off, pt(line, sb) + nb * off, pt(line, sb) + nb * (off + d), pt(line, sa) + na * (off + d)])
    if not quad.is_valid or quad.area < 0.5 * w * d or not free(quad): return None, w
    # the house stands at the front of its plot
    u = pt(line, sb) - pt(line, sa); u /= np.linalg.norm(u); v = (na + nb) / 2; v /= np.linalg.norm(v); c0 = pt(line, sa) + na * off
    if kind == "church":
        cc = c0 + u * w / 2 + v * d * 0.5; nave = Polygon([cc - u * 13 - v * 4, cc + u * 13 - v * 4, cc + u * 13 + v * 4, cc - u * 13 + v * 4])
        tr = Polygon([cc + u * 3 - v * 9, cc + u * 9 - v * 9, cc + u * 9 + v * 9, cc + u * 3 + v * 9]); special.append(("church", quad, nave.union(tr)))
    elif kind == "manor":
        cc = c0 + u * w / 2 + v * d * 0.45; hall = Polygon([cc - u * 14 - v * 5, cc + u * 14 - v * 5, cc + u * 14 + v * 5, cc - u * 14 + v * 5])
        wing = rect_at(cc - u * 14 + v * 5, u, v, 8, 12); barn = rect_at(c0 + u * (w - 16) + v * (d - 12), u, v, 13, 7); special.append(("manor", quad, [hall.union(wing), barn]))
    elif row:
        houses.append(rect_at(c0 + v * 0.5, u, v, w, rng.uniform(7, 9)))
    else:
        hw, hd = min(w - 3, rng.uniform(7.5, 11.5)), rng.uniform(5.5, 7.5)
        if rng.random() < 0.25: hw, hd = hd, min(hw, 10)
        sb_ = rng.uniform(1.5, 6); ox = rng.uniform(1, max(1.1, w - hw - 1))
        houses.append(rect_at(c0 + u * ox + v * sb_, u, v, hw, hd))
        if w > 15.5 and rng.random() < 0.3:      # a farmstead: barn and shed behind, drawing only
            sheds.append(rect_at(c0 + u * rng.uniform(1, w - 10) + v * (sb_ + hd + rng.uniform(6, 12)), u, v, rng.uniform(7, 10), rng.uniform(4.5, 6)))
            if rng.random() < 0.5: sheds.append(rect_at(c0 + u * rng.uniform(1, w - 5) + v * (d - 6), u, v, 4, 3.5))
    occupied.append(quad); plots.append((quad, "row" if row else kind)); used_roads.add(id(line)); return quad, w

def cursors():
    cs = []
    for i, (l, wd, kind) in enumerate(roads):
        s0 = l.project(Point(0, 0)) if kind == "road" else (0.0 if l.coords[0] != l.coords[-1] else 0.0)
        for side in ((1, -1) if not (green is not None and i == 1) else (1,)):
            if green is not None and i == 1:
                side_out = 1 if not green.contains(Point(pt(l, 5) + np.array([-tangent(l, 5)[1], tangent(l, 5)[0]]) * 6)) else -1
                cs.append([i, side_out, 1, 2.0]); continue
            if kind == "road": cs += [[i, side, 1, s0 + 4], [i, side, -1, s0 - 4]]
            else: cs.append([i, side, 1, 9.0])
    return cs
CAP = 70 + 0.85 * N
def frontage(line, wd):
    """How many plots a lane could take: free 14 x 30 m boxes along both sides."""
    n_ = 0
    for ss in np.arange(10, line.length - 8, 16):
        t = tangent(line, ss); nn = np.array([-t[1], t[0]])
        for sd in (1, -1):
            if free(rect_at(pt(line, ss) + nn * sd * (wd / 2 + 0.8), t, nn * sd, 14, 30)): n_ += 1
    return n_
def thicken():
    """A new lane grows off an existing lane (or the road inside the village), towards open ground.
    It may run into another lane and join it, or stop as a close."""
    best, bscore = None, 3
    others = [l for l, w, k in roads]
    REACH = CAP * (1.05 if shape == "cross" else 1.5)
    for _ in range(40):
        j = int(rng.integers(len(roads))); l, w, k = roads[j]
        if l.length < 40: continue
        if k == "road":
            ss = s0m + rng.uniform(-CAP, CAP) if j == 0 else l.project(Point(0, 0)) + rng.uniform(-CAP, CAP)
        else: ss = rng.uniform(0.3, 1.0) * l.length
        ss = float(np.clip(ss, 3, l.length - 3)); p = pt(l, ss); t = tangent(l, ss)
        if np.hypot(*p) > REACH: continue
        at_end = k == "lane" and ss > l.length - 12 and l.coords[0] != l.coords[-1]
        if at_end: d = t * math.cos(a_ := rng.normal(0, 0.5)) + np.array([-t[1], t[0]]) * math.sin(a_)
        else:
            n = np.array([-t[1], t[0]]) * (1 if rng.random() < 0.5 else -1); a_ = rng.normal(0, 0.35)
            d = n * math.cos(a_) + t * math.sin(a_)
        if coast_dir is not None and np.dot(d, coast_dir) > 0.3: continue
        L = rng.uniform(75, 150); line = LineString(wander(p, p + d * L, 9, k=3))
        line = clip_water(line) if water is not None else line
        if line is None or Point(line.coords[0]).distance(Point(p)) > 3: continue
        if green is not None and line.distance(green) < 6: continue
        # stop where it runs into another way, joining it
        hit = None
        for o in others:
            if o is l: continue
            x = line.intersection(o)
            for q in (x.geoms if hasattr(x, "geoms") else [x]):
                if q.geom_type == "Point":
                    dd = line.project(q)
                    if dd > 25 and (hit is None or dd < hit): hit = dd
        joined = hit is not None
        if hit is not None: line = substring(line, 0, hit)
        elif any(o is not l and o.distance(Point(line.coords[-1])) < 55 for o in others):
            joined = True
            o = min((o for o in others if o is not l), key=lambda o: o.distance(Point(line.coords[-1])))
            q = o.interpolate(o.project(Point(line.coords[-1]))); line = LineString(list(line.coords) + [(q.x, q.y)])
        if line.length < 45: continue
        # not alongside another way
        body = substring(line, 18, max(line.length - 18, 19))
        if any(o.distance(body) < 26 for o in others if o is not l): continue
        if l.distance(substring(line, 30, line.length)) < 22: continue
        if np.hypot(*line.coords[-1]) > REACH * 1.15: continue
        mid = np.array(line.interpolate(0.5, normalized=True).coords[0])
        sc = frontage(line, LANE) * (1.45 if joined else 1.0) - 0.012 * np.hypot(*mid) + rng.uniform(0, 1.5)
        if sc > bscore: best, bscore = line, sc
    if best is None: return False
    roads.append((best, LANE, "lane")); return True
active = cursors(); placed = 0; lanes_added = 0; want_church = True; want_manor = shape == "green"
guard = 0
while placed < N and guard < 6000:
    guard += 1
    live = [c for c in active if 0 <= c[3] <= roads[c[0]][0].length]
    live = [c for c in live if Point(pt(roads[c[0]][0], c[3])).distance(Point(0, 0)) < ((CAP if roads[c[0]][2] == 'road' else CAP * 2.2) if N >= 90 else 520)]
    if not live:
        if lanes_added < 60 and (thicken() if N >= 90 else add_lane(lanes_added)):
            i = len(roads) - 1; active += [[i, 1, 1, 9.0], [i, -1, 1, 9.0]]
        lanes_added += 1
        if lanes_added > 64: break
        continue
    c = min(live, key=lambda c: Point(pt(roads[c[0]][0], c[3])).distance(Point(0, 0)) * ((1.9 if N >= 90 else 1.0) if roads[c[0]][2] == "road" else 1.0) + (0 if roads[c[0]][2] == "road" else 18))
    l, wd, kind = roads[c[0]]
    dist = Point(pt(l, c[3])).distance(Point(0, 0))
    k = "house"
    if want_church and dist > (20 if green is None else 0) and (green is None or c[0] == 1): k = "church"
    elif want_manor and dist > 120 and kind == "road": k = "manor"
    q, w = make_plot(l, wd, c[3], c[1], c[2], k)
    if q is not None:
        if k == "church": want_church = False
        elif k == "manor": want_manor = False
        placed += 1; since_lane[0] += 1; c[3] += c[2] * (w + (0 if (ROW and dist < 70) else rng.uniform(0, 5)))
    else:
        c[3] += c[2] * 5.0
    # a new lane before the village strings out too far along its road
    if N < 90 and placed and since_lane[0] >= 14 and dist > 45 + 5.5 * math.sqrt(N) and lanes_added < 14 and kind == "road":
        since_lane[0] = 0
        if add_lane(lanes_added):
            i = len(roads) - 1; active += [[i, 1, 1, 9.0], [i, -1, 1, 9.0]]
        lanes_added += 1

plot_u = unary_union([p for p, _ in plots]); hull = plot_u.convex_hull
# mill by the river, landing on the shore
if river is not None and bridges:
    X = bridges[0]; t = tangent(river, river.project(X)); n = np.array([-t[1], t[0]])
    for sg in (1, -1):
        cand = rect_at(np.array([X.x, X.y]) + t * 22 * sg + n * 9, t * sg, n, 12, 8)
        if free(cand): mill = cand; occupied.append(cand); break
if shape == "shore":
    foot = coast.interpolate(coast.project(Point(0, 0))); f = np.array([foot.x, foot.y])
    landing.append(LineString([f - coast_dir * 4, f + coast_dir * 26]).buffer(1.8, cap_style=2))
    roads.append((LineString([pt(main, main.project(foot)), f]), LANE, "lane"))
    boats = [affinity.rotate(affinity.scale(Point(f + coast_dir * rng.uniform(6, 22) + np.array([-coast_dir[1], coast_dir[0]]) * rng.uniform(-26, 26)).buffer(1), 3.2, 1.2), rng.uniform(0, 180)) for _ in range(6)]
else: boats = []
# trim roads to a little beyond the last plot; the through road runs on
reach = hull.buffer(200)
# palisade for the crossroads village (the "walls" flag, shrunk)
palisade = None
if shape == "cross":
    P_ = np.vstack([np.array(p.exterior.coords) for p, _ in plots]); c0_ = P_.mean(axis=0)
    w_, v_ = np.linalg.eigh(np.cov((P_ - c0_).T)); ax1, ax2 = v_[:, 1], v_[:, 0]
    r1 = np.abs((P_ - c0_) @ ax1).max(); r2 = np.abs((P_ - c0_) @ ax2).max()
    r2 = max(r2, 0.8 * r1); r1 = max(r1, 0.8 * r2)            # never far from a circle
    th = np.linspace(0, 2 * math.pi, 120, endpoint=False); ph = rng.uniform(0, 6.28)
    k_ = 1.0
    while True:
        wob = 1 + 0.025 * np.sin(3 * th + ph) + 0.015 * np.sin(5 * th + 2 * ph)
        ring = c0_ + np.outer(np.cos(th) * r1 * k_ * wob, ax1) + np.outer(np.sin(th) * r2 * k_ * wob, ax2)
        palisade = Polygon(ring)
        if palisade.buffer(-9).contains(plot_u) or k_ > 1.8: break
        k_ += 0.03
# ---------------- 5 fields, tracks, trees
village = palisade.buffer(7) if palisade is not None else plot_u.buffer(26, join_style=1).buffer(-16, join_style=1)
village = Polygon(max(village.geoms, key=lambda q: q.area).exterior) if hasattr(village, 'geoms') else Polygon(village.exterior)
field_zone = hull.buffer(230 if N < 110 else 290).difference(village)
if water is not None: field_zone = field_zone.difference(water.buffer(6))
if green is not None: field_zone = field_zone.difference(green.buffer(8)); village = village.union(green.buffer(8))
field_zone = field_zone.difference(unary_union([l.buffer(w / 2 + 1.5) for i_, (l, w, k) in enumerate(roads) if k == "road"]))
def bisect(poly, gap):
    mrr = poly.minimum_rotated_rectangle; c = np.array(mrr.exterior.coords); e1, e2 = c[1] - c[0], c[2] - c[1]
    a0, le, se = (c[0], e1, e2) if np.hypot(*e1) >= np.hypot(*e2) else (c[1], e2, -e1)
    p1 = a0 + le * rng.uniform(0.35, 0.65) + se * 0.5; u = se / (np.hypot(*se) + 1e-9); a = rng.normal(0, 0.12)
    u = np.array([u[0] * math.cos(a) - u[1] * math.sin(a), u[1] * math.cos(a) + u[0] * math.sin(a)])
    res = poly.difference(LineString([p1 - u * 3000, p1 + u * 3000]).buffer(gap / 2, cap_style=2))
    return [q for q in (res.geoms if hasattr(res, "geoms") else [res]) if q.geom_type == "Polygon" and q.area > 300]
def fields_of(poly, lim, depth=0):
    if poly.area < lim or depth > 9: return [poly]
    hs = bisect(poly, 2.2)
    return [poly] if len(hs) < 2 else [f for h in hs for f in fields_of(h, lim * rng.uniform(0.8, 1.25), depth + 1)]
fields = []
for part in (field_zone.geoms if hasattr(field_zone, "geoms") else [field_zone]):
    if part.geom_type == "Polygon" and part.area > 600: fields += fields_of(part, rng.uniform(5000, 11000))
FCOL = ["#c9c79f", "#bfc59d", "#d3cba1", "#b7bf98", "#cdc6a8", "#c2c8a6"]
furrows, woods, trees = [], [], []
fcols = []
for f in fields:
    if rng.random() < 0.13 and f.distance(Point(0, 0)) > 140:
        woods.append(f); fcols.append("#a9b592")
        minx, miny, maxx, maxy = f.bounds
        for _ in range(int(f.area / 55)):
            p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
            if f.contains(p): trees.append((p.x, p.y, rng.uniform(2.6, 4.4)))
        continue
    fcols.append(FCOL[rng.integers(len(FCOL))])
    mrr = f.minimum_rotated_rectangle; c = np.array(mrr.exterior.coords); e1, e2 = c[1] - c[0], c[2] - c[1]
    a0, le, se = (c[0], e1, e2) if np.hypot(*e1) >= np.hypot(*e2) else (c[1], e2, -e1)
    nl = int(np.hypot(*se) / 6.5)
    for k_ in range(1, nl):
        ln = LineString([a0 + se * k_ / nl, a0 + se * k_ / nl + le]).intersection(f.buffer(-1.2))
        for q in (ln.geoms if hasattr(ln, "geoms") else [ln]):
            if q.geom_type == "LineString" and q.length > 6: furrows.append(np.array(q.coords))
# a few trees along plot backs and the green
for p, kind in plots:
    if kind in ("house",) and rng.random() < 0.35:
        c_ = p.exterior.coords[2 if rng.random() < 0.5 else 3]; trees.append((c_[0] + rng.normal(0, 2), c_[1] + rng.normal(0, 2), rng.uniform(2.4, 3.6)))

# ---------------- draw
fig, ax = plt.subplots(figsize=(11, 11), dpi=int(os.environ.get("DPI", 100))); ax.set_facecolor("#c5c4b4"); fig.patch.set_facecolor("#c5c4b4")
def fill(geom, col, z, ec="none", lw=0):
    for q in (geom.geoms if hasattr(geom, "geoms") else [geom]):
        if q.geom_type == "Polygon" and not q.is_empty: ax.add_collection(PolyCollection([np.array(q.exterior.coords)], facecolor=col, edgecolor=ec, linewidth=lw, zorder=z))
ax.add_collection(PolyCollection([np.array(f.exterior.coords) for f in fields], facecolor=fcols, edgecolor="#a7a88c", linewidth=0.5, zorder=1))
ax.add_collection(LineCollection(furrows, colors="#a9aa8a", linewidths=0.35, zorder=1.2))
fill(village.difference(water.buffer(1)) if water is not None else village, "#bcc3a0", 1.6)
if water is not None: fill(water, "#8d9a9c", 2, ec="#3f322c", lw=0.6)
for l, w, k in roads:
    if k == "lane" and id(l) not in used_roads and not (shape == "shore" and l is roads[-1][0]) and not (green is not None and l is roads[1][0]): continue
    seg = l if k == "road" else l.intersection(village)
    fill(seg.buffer(w / 2), "#e1dbd5", 3, ec="#8a8172", lw=0.5)
for X in bridges: fill(Point(X).buffer(1).envelope, "#e1dbd5", 3.2); fill(LineString([pt(main, main.project(X) - 11), pt(main, main.project(X) + 11)]).buffer(ROAD / 2 + 1, cap_style=2), "#d8d0c4", 3.3, ec="#3f322c", lw=0.9)
if green is not None:
    fill(green, "#b4c08f", 3.4, ec="#8a9070", lw=0.6)
    if pond is not None and not pond.is_empty: fill(pond, "#8d9a9c", 3.5, ec="#3f322c", lw=0.5)
    gc = np.array(green.centroid.coords[0]); ax.plot(gc[0], gc[1], "o", ms=5, mfc="#e1dbd5", mec="#3f322c", mew=1.1, zorder=6)
ax.add_collection(PolyCollection([np.array(p.exterior.coords) for p, k in plots if k != "row"], facecolor="#b9c39a", edgecolor="#8f9676", linewidth=0.5, zorder=4))
ax.add_collection(PolyCollection([np.array(p.exterior.coords) for p, k in plots if k == "row"], facecolor="#c8c4ae", edgecolor="#8f9676", linewidth=0.4, zorder=4))
ax.add_collection(PolyCollection([np.array(h.exterior.coords) for h in sheds], facecolor="#8e8a80", edgecolor="#3f322c", linewidth=0.4, zorder=5))
ax.add_collection(PolyCollection([np.array(h.exterior.coords) for h in houses], facecolor="#66667e", edgecolor="#3f322c", linewidth=0.5, zorder=5.2))
for kind, quad, fp in special:
    fill(quad, "#c3c9a6" if kind == "church" else "#cfc9b4", 4.2, ec="#5a5348", lw=1.3)
    for g_ in (fp if isinstance(fp, list) else [fp]): fill(g_, "#3d3d3d", 6, ec="#1f1b18", lw=0.5)
if mill is not None: fill(mill, "#3d3d3d", 6, ec="#1f1b18", lw=0.5); mc = mill.centroid; ax.plot(mc.x, mc.y, "o", ms=6, mfc="none", mec="#1f1b18", mew=1.0, zorder=7)
for lg in landing: fill(lg, "#8c7d68", 6, ec="#3f322c", lw=0.6)
for b in boats: fill(b, "#e1dbd5", 6.2, ec="#3f322c", lw=0.5)
if green is None:
    wp = pt(main, main.project(Point(0, 0))); ax.plot(wp[0], wp[1], "o", ms=4.5, mfc="#e1dbd5", mec="#3f322c", mew=1.1, zorder=7)
for x_, y_, r_ in trees: ax.add_patch(plt.Circle((x_, y_), r_, facecolor="#8fa07a", edgecolor="#667255", linewidth=0.35, zorder=5.5))
if palisade is not None:
    ring = LineString(palisade.exterior.coords); cut = ring
    for l, w, k in roads:
        if k == "road": cut = cut.difference(l.buffer(w / 2 + 3))
    for q in (cut.geoms if hasattr(cut, "geoms") else [cut]):
        xy = np.array(q.coords); ax.plot(xy[:, 0], xy[:, 1], color="#5c4a34", lw=2.2, zorder=7); ax.plot(xy[:, 0], xy[:, 1], color="#5c4a34", lw=3.6, ls=(0, (0.6, 2.2)), zorder=7)
c_ = np.array(hull.centroid.coords[0]); e = max(230, math.sqrt(hull.area) * 0.78 + 150)
ax.set_xlim(c_[0] - e, c_[0] + e); ax.set_ylim(c_[1] + e, c_[1] - e); ax.set_aspect("equal"); ax.axis("off")
ax.plot([c_[0] - e * .93, c_[0] - e * .93 + 100], [c_[1] + e * .93] * 2, color="#3f322c", lw=2); ax.text(c_[0] - e * .93 + 106, c_[1] + e * .94, "100 m", fontsize=11, color="#3f322c")
names = {"street": "Along a road, with a stream and mill", "green": "Round a green, with a manor", "cross": "At a crossroads, with a palisade", "shore": "On a shore, with a landing"}
ax.text(c_[0] - e * .95, c_[1] - e * .92, f"{names[shape]} · {placed} buildings", fontsize=int(os.environ.get("FS", 15)), weight="bold", color="#3f322c")
fig.savefig(out, bbox_inches="tight"); print(shape, N, "placed", placed, "lanes", len(roads) - 1, "fields", len(fields))
