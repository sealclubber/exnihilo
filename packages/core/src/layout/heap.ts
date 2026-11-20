/** A small binary heap of [cost, node], lowest cost first, ties by node. */
export class Heap {
  private readonly items: Array<[number, number]> = [];

  get size(): number {
    return this.items.length;
  }

  push(cost: number, node: number): void {
    const { items } = this;
    items.push([cost, node]);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.before(items[at] as [number, number], items[parent] as [number, number])) break;
      [items[at], items[parent]] = [items[parent] as [number, number], items[at] as [number, number]];
      at = parent;
    }
  }

  pop(): [number, number] {
    const { items } = this;
    const top = items[0] as [number, number];
    const last = items.pop() as [number, number];
    if (items.length > 0) {
      items[0] = last;
      let at = 0;
      for (;;) {
        let least = at;
        for (const child of [2 * at + 1, 2 * at + 2]) {
          if (child < items.length && this.before(items[child] as [number, number], items[least] as [number, number])) least = child;
        }
        if (least === at) break;
        [items[at], items[least]] = [items[least] as [number, number], items[at] as [number, number]];
        at = least;
      }
    }
    return top;
  }

  private before(a: [number, number], b: [number, number]): boolean {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
}
