# Isocard

**Isocard** is a versatile, isomorphic scene management library built on top of [Three.js](https://threejs.org/) and [Jolt Physics](https://github.com/jrouwe/JoltPhysics). It provides a unified interface for creating, managing, and simulating 3D scenes with physics and optional AI-driven behaviors, seamlessly supporting both client-side (browser) and server-side (Node.js/Bun) environments. With a JSON-driven configuration, Isocard enables developers to define complex scenes, run physics simulations, and integrate automation or AI policies with ease.

---

## ✨ Features

- **Isomorphic Runtime**: Run the same code in the browser or on a server, enabling consistent behavior across environments.
- **Three.js & Jolt Physics Integration**: Combines powerful 3D rendering with robust physics simulations out of the box.
- **JSON-Driven Scenes**: Define scenes using a simple, serializable JSON format for easy creation, sharing, and replaying of experiments.
- **Deterministic Simulations**: Record inputs and replay simulations with consistent results for reliable testing and experimentation.
- **Headless Mode**: Execute physics simulations without rendering, ideal for server-side computations or AI training.
- **Extensible Architecture**: Integrate custom controllers, automation scripts, or AI policies to enhance scene behavior.
- **Dynamic Object Management**: Add, update, or remove objects with physics properties in real-time.
- **Camera & Layer Control**: Fine-tune camera settings and manage object layers for visibility and rendering control.

## 📦 Installation

Install Isocard using your preferred package manager:

```bash
# Using Bun
bun add @openfluke/isocard

# Using npm
npm install @openfluke/isocard
```

Ensure you have the required dependencies installed:

```bash
bun add three jolt-physics
# or
npm install three jolt-physics
```

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
├── src/
│   ├── isocard.ts    # Core Isocard class implementation
│   ├── index.ts      # Package entrypoint
├── dist/             # Compiled output (published to npm)
├── package.json      # Project metadata and scripts
├── README.md         # Project documentation
```

---

## 🧪 Getting Started with Development

To develop or contribute to Isocard, follow these steps:

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/openfluke/isocard
   cd isocard
   ```

2. **Install Dependencies**:
   ```bash
   bun install
   ```

3. **Build the Project**:
   ```bash
   bun run build
   ```

4. **Link Locally for Testing**:
   ```bash
   bun link
   ```
   In your test project:
   ```bash
   bun link @openfluke/isocard
   ```

5. **Run a Development Server** (for frontend testing):
   ```bash
   bun run dev
   ```

---

## 🌐 Resources

- [Three.js Documentation](https://threejs.org/docs/)
- [Jolt Physics GitHub](https://github.com/jrouwe/JoltPhysics)
- [Example Frontend Implementation](https://github.com/openfluke/icfront)


## 📜 License

Apache License 2.0 © 2025 Samuel Watson