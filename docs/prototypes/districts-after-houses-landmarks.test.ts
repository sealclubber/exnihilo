import { test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { generateCity } from '../src/index.ts';
import { planTown, townInput } from '../src/layout/staged/plan.ts';
import { medievalPack, lomiaWorld } from './pack.ts';

function components(nodes: number[], adj: (n: number) => number[]): number {
  const set = new Set(nodes); let c = 0;
  while (set.size) { c++; const st = [set.values().next().value as number]; set.delete(st[0]!); while (st.length) { const n = st.pop()!; for (const m of adj(n)) if (set.has(m)) { set.delete(m); st.push(m); } } }
  return c;
}
test('districts after houses', () => {
  const pack = medievalPack(); const out: any = {};
  const all = lomiaWorld().settlements.filter((s: any) => s.population >= 1000);
  const names = process.env.SAMPLE ? all.filter((_: any, i: number) => i % Number(process.env.SAMPLE) === Number(process.env.OFFSET ?? 0)).map((s: any) => s.name) : (process.env.TOWNS ?? 'Badanos,Pombal,Ruha,Karlen,Horncesham,Cevilefon').split(',');
  for (const name of names) {
    const brief = lomiaWorld().settlements.find((s: any) => s.name === name)!; const city: any = generateCity(brief, pack);
    const t0 = Date.now(); const plan: any = planTown(brief, townInput(city, pack), pack);
    const D = plan.districts.length, W = plan.wards.length, B = plan.blocks.length;
    const keptB = new Array(B).fill(0), keptW = new Array(W).fill(0);
    plan.houses.forEach((h: any, i: number) => { if (plan.selection.district[i] !== undefined) { keptB[h.block]++; keptW[h.ward]++; } });
    const total = keptB.reduce((a: number, b: number) => a + b, 0);
    const want0 = plan.districts.map((d: any) => d.buildings); const s0 = want0.reduce((a: number, b: number) => a + b, 0);
    const T = want0.map((v: number) => v * total / s0);
    const imb = (have: number[]) => Math.round(have.reduce((a, v, i) => a + Math.abs(v - T[i]), 0) / 2);
    const haveF = new Array(D).fill(0); plan.forecast.of.forEach((d: number | undefined, w: number) => { if (d !== undefined) haveF[d] += keptW[w]; });
    const wadj = plan.forecast.beside as Array<Array<{ ward: number; cost: number }>>;
    const cen = plan.wards.map((w: any) => { const p = w.polygon; return [p.reduce((a: number, q: number[]) => a + q[0], 0) / p.length, p.reduce((a: number, q: number[]) => a + q[1], 0) / p.length]; });
    const of: Array<number | undefined> = new Array(W).fill(undefined); const have = new Array(D).fill(0); const seedW: number[] = [];
    const order = [...Array(D).keys()];
    for (const d of order) {
      let s = plan.forecast.seeds[d] as number | undefined;
      if (s === undefined || of[s] !== undefined || keptW[s] === 0) { const ref = s !== undefined ? cen[s] : [0, 0]; let best = -1, bd = 1e18; for (let w = 0; w < W; w++) if (of[w] === undefined && keptW[w] > 0) { const dd = Math.hypot(cen[w][0] - ref[0], cen[w][1] - ref[1]); if (dd < bd) { bd = dd; best = w; } } s = best; }
      if (s < 0) { seedW.push(-1); continue; } of[s] = d; have[d] += keptW[s]; seedW.push(s);
    }
    const full = new Array(D).fill(false);
    for (let guard = 0; guard < W * 4; guard++) {
      const cands = order.filter((d) => !full[d] && seedW[d]! >= 0).sort((a, b) => have[a] / T[a] - have[b] / T[b]); let done = false;
      for (const d of cands) {
        let best = -1, bs = 1e18;
        for (let w = 0; w < W; w++) if (of[w] === d) for (const e of wadj[w]!) if (of[e.ward] === undefined) { const sc = e.cost + Math.hypot(cen[e.ward][0] - cen[seedW[d]!][0], cen[e.ward][1] - cen[seedW[d]!][1]); if (sc < bs) { bs = sc; best = e.ward; } }
        if (best < 0) { full[d] = true; continue; }
        if (have[d] + keptW[best] / 2 > T[d] && cands.some((o) => o !== d && have[o] < T[o])) { full[d] = true; continue; }
        of[best] = d; have[d] += keptW[best]; done = true; break;
      }
      if (!done) { if (of.every((v, w) => v !== undefined || keptW[w] === 0)) break; full.fill(false); let any = false; for (let w = 0; w < W && !any; w++) if (of[w] === undefined && keptW[w] > 0) for (const e of wadj[w]!) if (of[e.ward] !== undefined) { of[w] = of[e.ward]; have[of[w]!] += keptW[w]; any = true; break; } if (!any) break; }
    }
    const unclaimed = keptW.reduce((a: number, v: number, w: number) => a + (of[w] === undefined ? v : 0), 0);
    const imbWard = imb(have);
    const bd: Array<number | undefined> = plan.blocks.map((b: any) => of[b.ward]);
    const badj: number[][] = plan.tilesBeside.slice(0, B).map((l: number[]) => l.filter((x) => x < B));
    for (const l of plan.links) if (l.a < B && l.b < B) { badj[l.a]!.push(l.b); badj[l.b]!.push(l.a); }
    const haveB = new Array(D).fill(0); bd.forEach((d, b) => { if (d !== undefined) haveB[d] += keptB[b]; });
    const blocksOf = (d: number) => bd.map((x, b) => (x === d && keptB[b] > 0 ? b : -1)).filter((b) => b >= 0);
    const adjIn = (d: number) => (n: number) => badj[n]!.filter((m) => bd[m] === d);
    const pieces0 = order.map((d) => components(blocksOf(d), adjIn(d)));
    let moves = 0; const frozen = new Set<number>();
    for (let it = 0; it < (process.env.V1 ? 6000 : 0); it++) {
      let best: [number, number, number] | undefined, gain = 0;
      for (let b = 0; b < B; b++) { const a = bd[b]; if (a === undefined || frozen.has(b) || keptB[b] === 0 || haveB[a] <= T[a]) continue;
        for (const m of badj[b]!) { const t = bd[m]; if (t === undefined || t === a || haveB[t] >= T[t]) continue;
          const g = Math.abs(haveB[a] - T[a]) + Math.abs(haveB[t] - T[t]) - Math.abs(haveB[a] - keptB[b] - T[a]) - Math.abs(haveB[t] + keptB[b] - T[t]);
          if (g > gain) { gain = g; best = [b, a, t]; } } }
      if (!best) break; const [b, a, t] = best; const before = components(blocksOf(a), adjIn(a)); bd[b] = t;
      if (components(blocksOf(a), adjIn(a)) > before) { bd[b] = a; frozen.add(b); continue; }
      haveB[a] -= keptB[b]; haveB[t] += keptB[b]; moves++;
    }
    const pieces1 = order.map((d) => components(blocksOf(d), adjIn(d)));
    // ---- version 3: share districts among banks first, then grow by block in turns, then chains
    const bcen = plan.blocks.map((b: any) => { const p = b.polygon; return [p.reduce((a: number, q: number[]) => a + q[0], 0) / p.length, p.reduce((a: number, q: number[]) => a + q[1], 0) / p.length]; });
    const linkSet = new Set<string>(plan.links.flatMap((l: any) => [l.a + ':' + l.b, l.b + ':' + l.a]));
    const bank = new Array(B).fill(-1); let nb = 0;
    for (let k = 0; k < B; k++) if (bank[k] < 0) { const st = [k]; bank[k] = nb; while (st.length) { const x = st.pop()!; for (const m of badj[x]!) if (bank[m] < 0 && !linkSet.has(x + ':' + m)) { bank[m] = nb; st.push(m); } } nb++; }
    const cap = new Array(nb).fill(0); keptB.forEach((v: number, k: number) => (cap[bank[k]] += v));
    const nearestKept = (ref: number[], bk: number | undefined, taken: Set<number>) => { let best = -1, bs = 1e18; for (let k = 0; k < B; k++) if (!taken.has(k) && keptB[k] > 0 && (bk === undefined || bank[k] === bk)) { const dd = Math.hypot(bcen[k][0] - ref[0], bcen[k][1] - ref[1]); if (dd < bs) { bs = dd; best = k; } } return best; };
    // units: a district, or its part on one bank
    type Unit = { d: number; target: number; seed: number; extra?: number[]; far?: boolean };
    const taken = new Set<number>(); const units: Unit[] = [];
    for (const d of [...order].sort((x, y) => T[x] - T[y])) { const ref = seedW[d]! >= 0 ? cen[seedW[d]!] : [0, 0]; const k = nearestKept(ref, undefined, taken); if (k >= 0) { taken.add(k); units.push({ d, target: T[d], seed: k }); } }
    const demand = () => { const dm = new Array(nb).fill(0); units.forEach((u) => (dm[bank[u.seed]] += u.target)); return dm; };
    const linkEnds = plan.links.filter((l: any) => l.a < B && l.b < B).map((l: any) => [l.a, l.b]);
    let spans = 0, relocated = 0;
    let reseeded = 0;
    for (let round = 0; round < 30; round++) {
      const dm = demand(); let over = -1, ex = 2; for (let x = 0; x < nb; x++) if (dm[x] - cap[x] > ex) { ex = dm[x] - cap[x]; over = x; }
      if (over < 0) break;
      // a bridge from the crowded bank to the bank with most room
      let bestL: number[] | undefined, room = 0; for (const [p, q] of linkEnds) for (const [x, y] of [[p, q], [q, p]]) if (bank[x!] === over && bank[y!] !== over && cap[bank[y!]] - dm[bank[y!]] > room) { room = cap[bank[y!]] - dm[bank[y!]]; bestL = [x!, y!]; }
      if (!bestL) { // no bridge off this bank: its largest district starts on the bank with most room instead
        let tb = -1, tr = -1e18; for (let y = 0; y < nb; y++) if (y !== over && cap[y] > 0 && cap[y] - dm[y] > tr) { tr = cap[y] - dm[y]; tb = y; }
        const u0 = units.filter((u) => bank[u.seed] === over).sort((a, b) => b.target - a.target)[0]; if (tb < 0 || !u0) break;
        const k0 = nearestKept(bcen[u0.seed], tb, taken); if (k0 < 0) break; taken.delete(u0.seed); taken.add(k0); u0.seed = k0; reseeded++; continue; }
      const [near, far] = bestL; const move = Math.min(ex, room);
      // the district on the crowded bank nearest that bridge goes over, whole if it fits, else in part
      const here = units.filter((u) => bank[u.seed] === over).sort((u, v) => Math.hypot(bcen[u.seed][0] - bcen[near!][0], bcen[u.seed][1] - bcen[near!][1]) - Math.hypot(bcen[v.seed][0] - bcen[near!][0], bcen[v.seed][1] - bcen[near!][1]));
      // a district already crossing this bridge carries more over, rather than a second district crossing at the same place
      const sp = units.find((v) => (v.extra ?? []).includes(near!)); const fp = sp && units.find((v) => v.d === sp.d && (v.extra ?? []).includes(far!));
      if (sp && fp) { const m = Math.min(move, sp.target - 6); if (m > 0) { sp.target -= m; fp.target += m; continue; }
        fp.target += sp.target; fp.extra = undefined; taken.delete(sp.seed); units.splice(units.indexOf(sp), 1); spans--; relocated++; continue; }
      const u = here.find((v) => !v.extra) ; if (!u) break;
      // a bridgehead block belongs to the district that crosses there; a district already seeded on it starts next door
      const claim = (w: Unit, blk: number): boolean => { if (units.some((v) => v !== w && (v.extra ?? []).includes(blk))) return false;
        const v = units.find((x) => x !== w && x.seed === blk); taken.add(blk); if (v) { const k2 = nearestKept(bcen[blk], bank[blk], taken); if (k2 < 0) return false; v.seed = k2; taken.add(k2); }
        if (!w.extra) { if (w.seed !== blk) taken.delete(w.seed); w.seed = blk; w.extra = []; } w.extra.push(blk); return true; };
      if (u.target <= move + 3) { const k = nearestKept(bcen[far!], bank[far!], taken); if (k < 0) break; taken.delete(u.seed); u.seed = k; taken.add(k); relocated++; }
      else { const nu: Unit = { d: u.d, target: move, seed: far!, far: true }; if (!claim(nu, far!)) break; u.target -= move; units.push(nu); spans++; claim(u, near!); }
    }
    const U = units.length; const UT = units.map((u) => u.target); const uo = [...Array(U).keys()];
    const g: Array<number | undefined> = new Array(B).fill(undefined); const hv = new Array(U).fill(0);
    units.forEach((u, i) => { g[u.seed] = i; hv[i] += keptB[u.seed]; });
    units.forEach((u, i) => { for (const k of u.extra ?? []) if (g[k] === undefined) { g[k] = i; hv[i] += keptB[k]; } });
    const LM = process.env.LM ?? '0'; const lmOf: number[][] = uo.map(() => []); let preclaimed = 0;
    if (LM !== '0') for (const l of plan.landmarks) { if (l.district === undefined || l.block === undefined || l.block >= B) continue; const k = l.block as number; const cs = uo.filter((i) => units[i]!.d === l.district && bank[units[i]!.seed] === bank[k]); if (!cs.length) continue; const i = cs[0]!; if (g[k] === undefined) { g[k] = i; hv[i] += keptB[k]; } if (g[k] === i && !lmOf[i]!.includes(k)) { lmOf[i]!.push(k); preclaimed++; } }
    const front: Array<Set<number>> = uo.map(() => new Set<number>());
    const addFront = (i: number, k: number) => { for (const m of badj[k]!) if (g[m] === undefined && bank[m] === bank[units[i]!.seed]) front[i]!.add(m); };
    uo.forEach((i) => { addFront(i, units[i]!.seed); for (const k of units[i]!.extra ?? []) if (g[k] === i) addFront(i, k); for (const k of lmOf[i]!) addFront(i, k); });
    const stop = new Array(U).fill(false);
    for (let guard = 0; guard < B * 3; guard++) {
      const pri = (i: number) => hv[i] / UT[i]; // tried and rejected: letting bridgehead parts grow first (it walls in their neighbours)
      const cands = uo.filter((i) => !stop[i] && hv[i] < UT[i]).sort((x, y) => pri(x) - pri(y)); if (!cands.length) break; let done = false;
      for (const i of cands) { let best = -1, bs = 1e18; for (const k of front[i]!) { if (g[k] !== undefined) { front[i]!.delete(k); continue; } let sc = Math.hypot(bcen[k][0] - bcen[units[i]!.seed][0], bcen[k][1] - bcen[units[i]!.seed][1]); if (LM === '2') for (const q of lmOf[i]!) sc = Math.min(sc, Math.hypot(bcen[k][0] - bcen[q][0], bcen[k][1] - bcen[q][1]) + Math.hypot(bcen[q][0] - bcen[units[i]!.seed][0], bcen[q][1] - bcen[units[i]!.seed][1]) * 0.5); if (sc < bs) { bs = sc; best = k; } }
        if (best < 0) { stop[i] = true; continue; } g[best] = i; hv[i] += keptB[best]; front[i]!.delete(best); addFront(i, best); done = true; break; }
      if (!done) break;
    }
    for (let pass = 0; pass < 80; pass++) { let any = false; for (let k = 0; k < B; k++) if (g[k] === undefined) { let best = -1, bs = 1e18; for (const m of badj[k]!) { const i = g[m]; if (i !== undefined && bank[m] === bank[k] && hv[i] - UT[i] < bs) { bs = hv[i] - UT[i]; best = i; } } if (best >= 0) { g[k] = best; hv[best] += keptB[k]; any = true; } } if (!any) break; }
    // houses on a bank no district lives on (no bridge): they join the nearest district as an island
    let islands = 0; const islandD = new Set<number>();
    for (let k = 0; k < B; k++) if (g[k] === undefined && keptB[k] > 0) { let best = -1, bs = 1e18; units.forEach((u, i) => { const dd = Math.hypot(bcen[k][0] - bcen[u.seed][0], bcen[k][1] - bcen[u.seed][1]); if (dd < bs) { bs = dd; best = i; } }); if (best >= 0) { g[k] = best; hv[best] += keptB[k]; islands += keptB[k]; islandD.add(units[best]!.d); } }
    let released = 0;
    if (LM !== '0') { for (const i of uo) { const seen = new Set<number>([units[i]!.seed]); const st = [units[i]!.seed]; for (const e of units[i]!.extra ?? []) if (g[e] === i && !seen.has(e)) { seen.add(e); st.push(e); }
        while (st.length) { const x = st.pop()!; for (const m of badj[x]!) if (g[m] === i && bank[m] === bank[x] && !seen.has(m)) { seen.add(m); st.push(m); } }
        for (let k = 0; k < B; k++) if (g[k] === i && !seen.has(k)) { g[k] = undefined; hv[i] -= keptB[k]; released++; lmOf[i] = lmOf[i]!.filter((x) => x !== k); } }
      for (let pass = 0; pass < 80; pass++) { let any = false; for (let k = 0; k < B; k++) if (g[k] === undefined) { let best = -1, bs = 1e18; for (const m of badj[k]!) { const i = g[m]; if (i !== undefined && bank[m] === bank[k] && hv[i] - UT[i] < bs) { bs = hv[i] - UT[i]; best = i; } } if (best >= 0) { g[k] = best; hv[best] += keptB[k]; any = true; } } if (!any) break; } }
    const left2 = keptB.reduce((a: number, v: number, k: number) => a + (g[k] === undefined ? v : 0), 0);
    const distHave = () => { const h = new Array(D).fill(0); units.forEach((u, i) => (h[u.d] += hv[i])); return h; };
    const imbGrow = imb(distHave());
    const comps = (nodes: number[], adj: (n: number) => number[]) => { const set = new Set(nodes); let c = 0; while (set.size) { const st = [set.values().next().value as number]; set.delete(st[0]!); let has = false; while (st.length) { const n = st.pop()!; if (keptB[n] > 0) has = true; for (const m of adj(n)) if (set.has(m)) { set.delete(m); st.push(m); } } if (has) c++; } return c; };
    const bOf = (i: number) => g.map((x, k) => (x === i ? k : -1)).filter((k) => k >= 0);
    const aIn = (i: number) => (n: number) => badj[n]!.filter((m) => g[m] === i && bank[m] === bank[n]);
    const give = (from: number, to: number, want: number): number => {
      let cands: number[] = []; for (let k = 0; k < B; k++) if (g[k] === from && keptB[k] > 0 && k !== units[from]!.seed && !(units[from]!.extra ?? []).includes(k) && !lmOf[from]!.includes(k) && badj[k]!.some((m) => g[m] === to && bank[m] === bank[k])) cands.push(k);
      cands = cands.filter((k) => keptB[k] <= want + 2).sort((x, y) => keptB[y] - keptB[x]); const before = comps(bOf(from), aIn(from)), beforeTo = comps(bOf(to), aIn(to));
      for (const k of cands.slice(0, 12)) { g[k] = to; if (comps(bOf(from), aIn(from)) <= before && comps(bOf(to), aIn(to)) <= beforeTo) { hv[from] -= keptB[k]; hv[to] += keptB[k]; return keptB[k]; } g[k] = from; }
      return 0; };
    let chainMoves = 0; const dead = new Set<string>();
    for (let it = 0; it < 6000; it++) {
      const shortU = uo.filter((i) => UT[i] - hv[i] >= 2).sort((x, y) => (UT[y] - hv[y]) - (UT[x] - hv[x])); let moved = false;
      for (const i of shortU) {
        const dadj = new Map<number, Set<number>>(); for (let k = 0; k < B; k++) { const x = g[k]; if (x === undefined) continue; for (const m of badj[k]!) { const y = g[m]; if (y !== undefined && y !== x && bank[m] === bank[k]) { if (!dadj.has(x)) dadj.set(x, new Set()); dadj.get(x)!.add(y); } } }
        const prev = new Map<number, number>(); const q = [i]; const seen = new Set([i]); let src = -1;
        while (q.length && src < 0) { const x = q.shift()!; for (const y of dadj.get(x) ?? []) { if (seen.has(y) || dead.has(y + '>' + x)) continue; seen.add(y); prev.set(y, x); if (hv[y] - UT[y] >= 2) { src = y; break; } q.push(y); } }
        if (src < 0) continue;
        const want = Math.min(hv[src] - UT[src], UT[i] - hv[i]); let x = src; const path: number[] = [src]; while (x !== i) { x = prev.get(x)!; path.push(x); }
        for (let j = 0; j < path.length - 1; j++) { const got = give(path[j]!, path[j + 1]!, want); if (!got) { dead.add(path[j] + '>' + path[j + 1]); break; } chainMoves++; }
        moved = true; break;
      }
      if (!moved) break;
    }
    // a district is whole if its blocks join, a bridge counting as a join
    const dOfBlock = g.map((i) => (i === undefined ? undefined : units[i]!.d));
    const dPieces = order.map((d) => comps(dOfBlock.map((x, k) => (x === d ? k : -1)).filter((k) => k >= 0), (n) => badj[n]!.filter((m) => dOfBlock[m] === d)));
    const hD = distHave();
    const dbg: any[] = []; order.forEach((d) => { if (dPieces[d] <= 1) return; const nodes = dOfBlock.map((x, k) => (x === d ? k : -1)).filter((k) => k >= 0); const set = new Set(nodes); while (set.size) { const st = [set.values().next().value as number]; set.delete(st[0]!); let n = 0, hs = 0; const us = new Set<number>(), bs = new Set<number>(); while (st.length) { const x = st.pop()!; n++; hs += keptB[x]; us.add(g[x]!); bs.add(bank[x]); for (const m of badj[x]!) if (set.has(m)) { set.delete(m); st.push(m); } } dbg.push([plan.districts[d].kind, 'blocks', n, 'houses', hs, 'units', [...us], 'banks', [...bs]]); } });
    dbg.push(['units', units.map((u, i) => [i, plan.districts[u.d].kind, Math.round(u.target), hv[i], bank[u.seed], u.extra ?? null])]);
    // ---- exact step: whole-number targets, then single houses pass through shared border blocks
    const IT = T.map((v: number) => Math.floor(v)); { let r = total - IT.reduce((a: number, b: number) => a + b, 0); const fr = order.map((d) => [T[d] - IT[d], d]).sort((x, y) => y[0]! - x[0]!); for (let j = 0; j < r; j++) IT[fr[j % D]![1]!]++; }
    const hX = [...hD]; const shared = new Map<number, { to: number; n: number }>(); const deadX = new Set<string>(); let sharedHouses = 0;
    const offBefore = Math.round(hX.reduce((a, v, d) => a + Math.abs(v - IT[d]), 0) / 2);
    for (let it = 0; it < 4000; it++) {
      const shortD = order.filter((d) => IT[d] - hX[d] >= 1).sort((x, y) => (IT[y] - hX[y]) - (IT[x] - hX[x])); let moved = false;
      const dadj = new Map<number, Set<number>>(); for (let k = 0; k < B; k++) { const x = dOfBlock[k]; if (x === undefined) continue; for (const m of badj[k]!) { const y = dOfBlock[m]; if (y !== undefined && y !== x) { if (!dadj.has(x)) dadj.set(x, new Set()); dadj.get(x)!.add(y); } } }
      for (const i of shortD) {
        const prev = new Map<number, number>(); const q = [i]; const seen = new Set([i]); let src = -1;
        while (q.length && src < 0) { const x = q.shift()!; for (const y of dadj.get(x) ?? []) { if (seen.has(y) || deadX.has(y + '>' + x)) continue; seen.add(y); prev.set(y, x); if (hX[y] - IT[y] >= 1) { src = y; break; } q.push(y); } }
        if (src < 0) continue;
        let x = src; const path: number[] = [src]; while (x !== i) { x = prev.get(x)!; path.push(x); }
        let amt = Math.min(hX[src] - IT[src], IT[i] - hX[i]); const picks: number[] = []; let ok = true;
        for (let j = 0; j < path.length - 1 && ok; j++) { const a = path[j]!, b = path[j + 1]!; let best = -1, room = 0;
          for (let k = 0; k < B; k++) if (dOfBlock[k] === a && keptB[k] > 1 && badj[k]!.some((m) => dOfBlock[m] === b)) { const sh = shared.get(k); if (sh && sh.to !== b) continue; const r = keptB[k] - 1 - (sh?.n ?? 0); if (r > room) { room = r; best = k; } }
          if (best < 0) { deadX.add(a + '>' + b); ok = false; } else { amt = Math.min(amt, room); picks.push(best); } }
        if (!ok) { moved = true; break; }
        picks.forEach((k, j) => { const sh = shared.get(k) ?? { to: path[j + 1]!, n: 0 }; sh.n += amt; shared.set(k, sh); }); hX[src] -= amt; hX[i] += amt; sharedHouses += amt * picks.length; moved = true; break;
      }
      if (!moved) break;
    }
    const offAfter = Math.round(hX.reduce((a, v, d) => a + Math.abs(v - IT[d]), 0) / 2);
    const stranded2 = plan.landmarks.filter((l: any) => l.district !== undefined && l.block !== undefined && dOfBlock[l.block] !== l.district).length;
    const v2 = { preclaimed, released, lmBlocks: plan.landmarks.filter((l: any) => l.district !== undefined && l.block !== undefined).length, reseeded, islands, piecesNotIsland: order.filter((d) => dPieces[d] > 1 && !islandD.has(d)).length, piecedKinds: order.filter((d) => dPieces[d] > 1).map((d) => plan.districts[d].kind + ':' + dPieces[d]), offBefore, offAfter, sharedBlocks: shared.size, sharedHouses, banks: cap.filter((c) => c > 0), spans, relocated, afterGrowthByBlock: imbGrow, afterChains: imb(hD), chainMoves, unclaimed: left2, pieces: dPieces.filter((p) => p > 1).length, maxOff: Math.max(...order.map((d) => Math.abs(hD[d] - T[d]))), worst: order.map((d) => [plan.districts[d].kind, Math.round(T[d]), hD[d], dPieces[d]]).sort((x: any, y: any) => Math.abs(y[2] - y[1]) - Math.abs(x[2] - x[1])).slice(0, 3), landmarksElsewhere: stranded2 };
    const stranded = plan.landmarks.filter((l: any) => l.district !== undefined && l.block !== undefined && bd[l.block] !== l.district).length;
    out[name] = { buildings: total, districts: D, wards: W, blocks: B, imbalanceToday: imb(haveF), afterHousesByWard: imbWard, afterBlockTrades: imb(haveB), blockMoves: moves, unclaimed, piecesBefore: pieces0.filter((p) => p > 1).length, piecesAfter: pieces1.filter((p) => p > 1).length, worst: order.map((d) => [plan.districts[d].kind, Math.round(T[d]), haveF[d], haveB[d]]).sort((x: any, y: any) => Math.abs(y[3] - y[1]) - Math.abs(x[3] - x[1])).slice(0, 3), landmarks: plan.landmarks.length, landmarksInAnotherDistrict: stranded, oldFallback: plan.selection.fallback, v2 }; console.log(name, total, Date.now() - t0, 'ms', v2.afterChains, v2.offAfter);
  }
  writeFileSync(process.env.OUT ?? '/tmp/r6.json', JSON.stringify(out, null, 1));
}, 7200000);
