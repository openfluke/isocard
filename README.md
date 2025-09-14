# isocard

**isocard** is a lightweight, isomorphic physics + AI scene wrapper built on top of [Three.js](https://threejs.org/) and [Jolt Physics](https://github.com/jrouwe/JoltPhysics).  
It provides a JSON-driven way to define, load, and run physics experiments that can run in both the browser and server environments.

---

## ✨ Features

- 🚀 **Isomorphic runtime** — same code works in browser or server (Node/Bun).
- 🎮 **Three.js + Jolt Physics** integration out of the box.
- 📦 **JSON-defined scenes** — easy to save, share, and replay experiments.
- 🔄 **Deterministic replay** — record inputs and re-run with the same results.
- 🧩 **Extensible** — wrap with controllers, automation, or AI policies.
- 🔌 **Headless mode** — run simulations without rendering for server-side compute.

---

## 📦 Installation

```bash
# with bun
bun add isocard

# or with npm
npm install isocard
```

---

## 🛠 Usage

### Basic Example

```ts
import * as THREE from "three";
import { IsoCard } from "isocard";

// dependencies passed into IsoCard
const deps = {
  THREE,
  // optional: lets IsoCard load Jolt if not available on `window`
  loadJolt: async () => (await import("jolt-physics")).default,
};

// create IsoCard instance
const iso = new IsoCard(
  { clientWidth: 800, clientHeight: 600, appendChild() {}, addEventListener() {} } as any,
  deps,
  { isPreview: true, isServer: true }
);

// setup physics
await iso.setupJOLT();
iso.loadSceneWithConstraints(JSON.stringify({
  objects: [
    { name: "box", shape: "box", size: [1, 1, 1], position: [0, 5, 0], physics: { motionType: "dynamic" } }
  ]
}));

iso.startPhysics();
iso.startAnimate();

console.log("Simulation running with", iso.dynamicObjects.length, "dynamic objects");
```

---

## 📂 Project Structure

```
src/
  isocard.ts    # main IsoCard class
  index.ts      # entrypoint
dist/           # compiled output (published)
```

---

## 🧪 Development

Clone and build locally:

```bash
git clone https://github.com/openfluke/isocard
cd isocard
bun install
bun run build
```

To use it in another local project:

```bash
bun link         # in isocard repo
bun link isocard # in your test project
```

---

## 📜 License

Apache License 2.0 © 2025 Samuel Watson