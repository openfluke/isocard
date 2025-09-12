// Soft interfaces to keep TS happy without going hard on types
type AnyRecord = Record<string, any>;

interface CameraConfig {
  position: [number, number, number];
  lookAt?: [number, number, number];
  fov?: number;
  near?: number;
  far?: number;
  locked?: boolean;
  orbitTarget?: [number, number, number];
  orbitEnabled?: boolean;
}

interface MeshObj {
  shape: AnyRecord;
  material?: AnyRecord;
  color?: number;
  pos: [number, number, number];
  rot: [number, number, number, number]; // quaternion
}

type PhysicsConfig = {
  motionType?: "static" | "dynamic" | "kinematic";
  mass?: number;
  friction?: number;
  restitution?: number;
  [k: string]: any;
};

// Dependency injection so we don’t import packages
type IsoDeps = {
  THREE: any; // required
  OrbitControls?: any; // optional if THREE.OrbitControls is available
  Stats?: any; // optional
  loadJolt?: (type?: string) => Promise<any>; // optional window.loadJolt replacement
};

export class IsoCard {
  // Static constants
  static LAYER_NON_MOVING: number = 0;
  static LAYER_MOVING: number = 1;
  static NUM_OBJECT_LAYERS: number = 2;

  // Injected libs
  private THREE: any;
  private OrbitControls?: any;
  private Stats?: any;
  private loadJolt?: IsoDeps["loadJolt"];

  // Scene / renderer / controls
  private container: HTMLElement | any;
  private scene: any;
  private camera: any;
  private renderer: any;
  private controls: any;
  private stats: any;

  // Scene state
  private isPreview: boolean = false;
  private isServer: boolean = false;
  private sceneConfig: any = {};
  private layers: Record<string, { visible: boolean; opacity: number }> = {};
  private objects: Array<{ id: any; threeObj: any; config: any }> = [];

  // Selection / input
  private selectedHelper: any = null;
  private raycaster: any;
  private mouse: any;
  private resizeObserver: any;

  // Physics
  private jolt: any = null;
  private physicsSystem: any = null;
  private bodyInterface: any = null;
  private jInterface: any = null;
  private dynamicObjects: any[] = [];
  private isPhysicsRunning: boolean = false;
  private time: number = 0;
  savedTransforms = new Map<any, any>();
  constraints: any[] = [];

  // Gravity & attractors
  private gravityType: "uniform" | "radial" = "uniform";
  private gravityStrength: number = 1000;
  private gravityCenter: any;
  private attractors: { position: any; strength: number }[] = [];

  // Camera save/lock
  private cameraLocked: boolean = false;
  private savedCameraState: {
    position: any;
    rotation: any;
    orbitTarget: any;
  } | null = null;

  // Timing
  private clock: any;
  private actionsPerSecond: number = 1;
  private lastActionTime: number = 0;

  // Callbacks
  private onSelectCallback?: (id: any) => void;
  private onObjectsChangeCallback?: () => void;
  private onExampleUpdate?: (time: number, deltaTime: number) => void;

  constructor(
    container: any,
    deps: IsoDeps,
    opts: { isPreview?: boolean; isServer?: boolean } = {}
  ) {
    // inject libs
    this.THREE = deps.THREE;
    this.OrbitControls =
      deps.OrbitControls ??
      (this.THREE as AnyRecord).OrbitControls ??
      (window as AnyRecord).OrbitControls;
    this.Stats = deps.Stats ?? (window as AnyRecord).Stats;
    this.loadJolt =
      deps.loadJolt ?? ((window as AnyRecord).loadJolt as IsoDeps["loadJolt"]);

    if (!this.THREE) throw new Error("THREE.js not provided");

    this.container = container;
    this.isPreview = !!opts.isPreview;
    this.isServer = !!opts.isServer;

    // base scene
    this.scene = new this.THREE.Scene();
    this.gravityCenter = new this.THREE.Vector3(0, 0, 0);
    this.attractors = [];

    // default scene config
    this.sceneConfig = {
      background: null,
      fog: null,
      environment: null,
      gravity: { type: "uniform", vector: [0, -9.81, 0] },
      camera: {
        position: [5, 5, 5],
        lookAt: [0, 0, 0],
        fov: 75,
        near: 0.1,
        far: 1000,
        locked: false,
        orbitTarget: [0, 0, 0],
        orbitEnabled: true,
      },
    };

    this.layers = { main: { visible: true, opacity: 1.0 } };
    this.clock = new this.THREE.Clock();
    this.dynamicObjects = [];

    if (!this.isServer) {
      // dimensions
      let width = container?.clientWidth || window.innerWidth;
      let height = container?.clientHeight || window.innerHeight;
      let aspect = width / height;
      if (width <= 0 || height <= 0 || !isFinite(aspect)) {
        width = window.innerWidth;
        height = window.innerHeight;
        aspect = width / height;
      }

      // camera/renderer
      this.camera = new this.THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
      this.renderer = new this.THREE.WebGLRenderer({ antialias: true });
      this.renderer.setSize(width, height);
      container.appendChild(this.renderer.domElement);

      // controls (prefer injected class)
      if (this.OrbitControls) {
        this.controls = new this.OrbitControls(
          this.camera,
          this.renderer.domElement
        );
      }

      this.camera.position.set(5, 5, 5);
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();

      // stats (optional)
      if (!this.isPreview && this.Stats) {
        this.stats = new this.Stats();
        container.appendChild(this.stats.dom);
      }

      // input / picking
      this.selectedHelper = null;
      this.raycaster = new this.THREE.Raycaster();
      this.mouse = new this.THREE.Vector2();

      setTimeout(() => {
        this.renderer.domElement.addEventListener(
          "click",
          this.onDocumentClick.bind(this),
          { capture: true }
        );
      }, 100);

      // resize
      this.resizeObserver = new ResizeObserver(this.onResize.bind(this));
      this.resizeObserver.observe(container);
      window.addEventListener("resize", this.onResize.bind(this));
    }

    // binders used elsewhere
    this.renderSync = this.renderSync.bind(this);
  }

  setOnSelectCallback(cb) {
    this.onSelectCallback = cb;
  }

  setOnObjectsChangeCallback(cb) {
    this.onObjectsChangeCallback = cb;
  }

  onDocumentClick(event) {
    if (this.isPreview) return;
    console.log("Click detected on canvas");
    event.preventDefault();
    const rect = this.renderer.domElement.getBoundingClientRect();
    console.log("Canvas rect:", rect);
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    console.log("Mouse coords:", this.mouse.x, this.mouse.y);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const checkableObjects = this.objects
      .filter((o) => {
        const layer = o.config.layer || "main";
        return (
          this.layers[layer] &&
          this.layers[layer].visible &&
          o.config.enabled !== false
        );
      })
      .map((o) => o.threeObj);
    console.log("Checkable objects:", checkableObjects.length);

    const intersects = this.raycaster.intersectObjects(checkableObjects, true);
    console.log("Intersects:", intersects.length);
    if (intersects.length > 0) {
      let object = intersects[0].object;
      console.log("Intersected object:", object);
      while (object && !this.objects.some((o) => o.threeObj === object)) {
        object = object.parent;
      }
      if (object) {
        const found = this.objects.find((o) => o.threeObj === object);
        console.log("Found object:", found);
        if (found && this.onSelectCallback) {
          console.log("Calling onSelectCallback with ID:", found.id);
          this.onSelectCallback(found.id);
        }
      }
    }
  }

  selectObject(id) {
    if (this.selectedHelper) {
      this.scene.remove(this.selectedHelper);
      this.selectedHelper = null;
    }
    const item = this.objects.find((o) => o.id === id);
    if (item && item.threeObj.isMesh) {
      this.selectedHelper = new this.THREE.BoxHelper(item.threeObj, 0xffff00);
      this.scene.add(this.selectedHelper);
    }
  }

  addObject(config) {
    try {
      let addedObj = null;

      // Default to enabled
      if (config.enabled === undefined) {
        config.enabled = true;
      }

      // Default to main layer
      if (!config.layer) {
        config.layer = "main";
      }

      // Create layer if it doesn't exist
      if (!this.layers[config.layer]) {
        this.layers[config.layer] = { visible: true, opacity: 0.5 };
      }

      if (config.type === "scene") {
        if (config.background !== undefined) {
          this.scene.background = new this.THREE.Color(config.background);
          this.sceneConfig.background = config.background;
        }
        if (config.fog) {
          this.scene.fog = new this.THREE.Fog(
            config.fog.color || 0xffffff,
            config.fog.near || 1,
            config.fog.far || 1000
          );
          this.sceneConfig.fog = config.fog;
        }

        if (config.gravity) {
          this.setGravityConfig(config.gravity);
        }

        if (config.camera) {
          this.setCameraConfig(config.camera);
        }

        if (this.onObjectsChangeCallback) this.onObjectsChangeCallback();
        return null;
      } else if (config.type === "light") {
        let light;
        switch (config.lightType) {
          case "directional":
            light = new this.THREE.DirectionalLight(
              config.color || 0xffffff,
              config.intensity || 1
            );
            if (config.castShadow) light.castShadow = true;
            break;
          case "ambient":
            light = new this.THREE.AmbientLight(config.color || 0x404040);
            break;
          case "point":
            light = new this.THREE.PointLight(
              config.color || 0xffffff,
              config.intensity || 1,
              config.distance || 100,
              config.decay || 1
            );
            break;
          case "spot":
            light = new this.THREE.SpotLight(
              config.color || 0xffffff,
              config.intensity || 1,
              config.distance || 100,
              config.angle || Math.PI / 3,
              config.penumbra || 0,
              config.decay || 1
            );
            break;
          case "hemisphere":
            light = new this.THREE.HemisphereLight(
              config.skyColor || 0xffffff,
              config.groundColor || 0x444444,
              config.intensity || 1
            );
            break;
          default:
            console.warn("Unsupported light type:", config.lightType);
            return null;
        }
        if (config.pos) light.position.fromArray(config.pos);
        if (config.target && light.target) {
          light.target.position.fromArray(config.target);
          this.scene.add(light.target);
        }
        addedObj = light;
      } else if (config.type === "helper") {
        let helper;
        switch (config.helperType) {
          case "grid":
            helper = new this.THREE.GridHelper(
              config.size || 10,
              config.divisions || 10,
              config.colorCenterLine || 0x444444,
              config.colorGrid || 0x888888
            );
            break;
          case "axes":
            helper = new this.THREE.AxesHelper(config.size || 5);
            break;
          default:
            console.warn("Unsupported helper type:", config.helperType);
            return null;
        }
        if (config.pos) helper.position.fromArray(config.pos);
        addedObj = helper;
      } else if (config.type === "mesh" || !config.type) {
        const geometry = this.createGeometry(config.shape || {});
        if (!geometry) return null;
        const material = config.material
          ? this.createMaterialFromObj(config.material)
          : this.createMaterialFromObj({
              type: "phong",
              color: config.color || 0xffffff,
            });
        if (!material) return null;

        // Apply layer-based opacity
        const layerOpacity = this.layers[config.layer].opacity;
        if (layerOpacity < 1) {
          material.transparent = true;
          material.opacity = material.opacity * layerOpacity;
        }

        const mesh = new this.THREE.Mesh(geometry, material);
        if (config.pos) mesh.position.fromArray(config.pos);

        // Handle rotation properly - convert euler angles from degrees to radians
        if (config.euler) {
          const eulerRad = config.euler.map((deg) => (deg * Math.PI) / 180);
          mesh.rotation.set(eulerRad[0], eulerRad[1], eulerRad[2]);
        } else if (config.rot) {
          // Support legacy rot as quaternion array
          if (config.rot.length === 4) {
            mesh.quaternion.fromArray(config.rot);
          } else {
            // If rot is euler angles in radians
            mesh.rotation.set(config.rot[0], config.rot[1], config.rot[2]);
          }
        }

        if (config.scale) mesh.scale.fromArray(config.scale);

        // Apply enabled state
        mesh.visible = config.enabled && this.layers[config.layer].visible;

        // Cast/receive shadows if enabled
        if (config.castShadow) mesh.castShadow = true;
        if (config.receiveShadow) mesh.receiveShadow = true;

        addedObj = mesh;

        if (
          config.shape?.type === "sphere" &&
          config.physics?.motionType === "static" &&
          config.physics?.gravityStrength
        ) {
          this.attractors.push({
            position: addedObj.position.clone(),
            strength: config.physics.gravityStrength,
          });
          console.log(
            "Added attractor at",
            addedObj.position,
            "with strength",
            config.physics.gravityStrength
          );
        }
      } else if (config.type === "group") {
        const group = new this.THREE.Group();
        if (config.pos) group.position.fromArray(config.pos);
        if (config.euler) {
          const eulerRad = config.euler.map((deg) => (deg * Math.PI) / 180);
          group.rotation.set(eulerRad[0], eulerRad[1], eulerRad[2]);
        }
        if (config.scale) group.scale.fromArray(config.scale);
        addedObj = group;
      } else {
        console.warn("Unsupported object type:", config.type);
        return null;
      }

      if (addedObj) {
        //const id = this.objects.length;
        const id = config.name;
        const newConfig = { ...config };
        if (!newConfig.name)
          newConfig.name = `${
            config.shape?.type || config.type || "object"
          } ${id}`;

        // Store layer info
        addedObj.userData.layer = config.layer;
        addedObj.userData.enabled = config.enabled;
        //console.log(this.objects);
        this.objects.push({ id, threeObj: addedObj, config: newConfig });
        this.scene.add(addedObj);
        if (this.onObjectsChangeCallback) this.onObjectsChangeCallback();
        return id;
      }
    } catch (err) {
      console.error("Error adding object:", err);
      return null;
    }
  }

  replaceObject(id, newConfig) {
    const index = this.objects.findIndex((o) => o.id === id);
    if (index === -1) return false;

    const oldObj = this.objects[index];

    // Remove old object from scene
    this.scene.remove(oldObj.threeObj);

    // Dispose of old geometry and materials
    if (oldObj.threeObj.geometry) oldObj.threeObj.geometry.dispose();
    if (oldObj.threeObj.material) {
      if (Array.isArray(oldObj.threeObj.material)) {
        oldObj.threeObj.material.forEach((m) => m.dispose());
      } else {
        oldObj.threeObj.material.dispose();
      }
    }

    // Remove from objects array temporarily
    this.objects.splice(index, 1);

    // Add new object with same ID
    const tempObjects = this.objects;
    this.objects = this.objects.slice(0, index);

    // Create new object
    let addedObj = null;

    // Preserve the ID and ensure proper defaults
    if (newConfig.enabled === undefined) {
      newConfig.enabled = true;
    }
    if (!newConfig.layer) {
      newConfig.layer = "main";
    }

    // Create the appropriate object type
    if (newConfig.type === "light") {
      let light;
      switch (newConfig.lightType) {
        case "directional":
          light = new this.THREE.DirectionalLight(
            newConfig.color || 0xffffff,
            newConfig.intensity || 1
          );
          if (newConfig.castShadow) light.castShadow = true;
          break;
        case "ambient":
          light = new this.THREE.AmbientLight(newConfig.color || 0x404040);
          break;
        case "point":
          light = new this.THREE.PointLight(
            newConfig.color || 0xffffff,
            newConfig.intensity || 1,
            newConfig.distance || 100,
            newConfig.decay || 1
          );
          break;
        case "spot":
          light = new this.THREE.SpotLight(
            newConfig.color || 0xffffff,
            newConfig.intensity || 1,
            newConfig.distance || 100,
            newConfig.angle || Math.PI / 3,
            newConfig.penumbra || 0,
            newConfig.decay || 1
          );
          break;
        case "hemisphere":
          light = new this.THREE.HemisphereLight(
            newConfig.skyColor || 0xffffff,
            newConfig.groundColor || 0x444444,
            newConfig.intensity || 1
          );
          break;
        default:
          console.warn("Unsupported light type:", newConfig.lightType);
          this.objects = [...this.objects, ...tempObjects.slice(index)];
          return false;
      }
      if (newConfig.pos) light.position.fromArray(newConfig.pos);
      if (newConfig.target && light.target) {
        light.target.position.fromArray(newConfig.target);
        this.scene.add(light.target);
      }
      addedObj = light;
    } else if (newConfig.type === "helper") {
      let helper;
      switch (newConfig.helperType) {
        case "grid":
          helper = new this.THREE.GridHelper(
            newConfig.size || 10,
            newConfig.divisions || 10,
            newConfig.colorCenterLine || 0x444444,
            newConfig.colorGrid || 0x888888
          );
          break;
        case "axes":
          helper = new this.THREE.AxesHelper(newConfig.size || 5);
          break;
        default:
          console.warn("Unsupported helper type:", newConfig.helperType);
          this.objects = [...this.objects, ...tempObjects.slice(index)];
          return false;
      }
      if (newConfig.pos) helper.position.fromArray(newConfig.pos);
      addedObj = helper;
    } else if (newConfig.type === "mesh" || !newConfig.type) {
      const geometry = this.createGeometry(newConfig.shape || {});
      if (!geometry) {
        this.objects = [...this.objects, ...tempObjects.slice(index)];
        return false;
      }
      const material = newConfig.material
        ? this.createMaterialFromObj(newConfig.material)
        : this.createMaterialFromObj({
            type: "phong",
            color: newConfig.color || 0xffffff,
          });
      if (!material) {
        geometry.dispose();
        this.objects = [...this.objects, ...tempObjects.slice(index)];
        return false;
      }

      // Apply layer-based opacity
      if (this.layers[newConfig.layer]) {
        const layerOpacity = this.layers[newConfig.layer].opacity;
        if (layerOpacity < 1) {
          material.transparent = true;
          material.opacity = material.opacity * layerOpacity;
        }
      }

      const mesh = new this.THREE.Mesh(geometry, material);
      if (newConfig.pos) mesh.position.fromArray(newConfig.pos);

      // Handle rotation properly - convert euler angles from degrees to radians
      if (newConfig.euler) {
        const eulerRad = newConfig.euler.map((deg) => (deg * Math.PI) / 180);
        mesh.rotation.set(eulerRad[0], eulerRad[1], eulerRad[2]);
      } else if (newConfig.rot) {
        if (newConfig.rot.length === 4) {
          mesh.quaternion.fromArray(newConfig.rot);
        } else {
          mesh.rotation.set(
            newConfig.rot[0],
            newConfig.rot[1],
            newConfig.rot[2]
          );
        }
      }

      if (newConfig.scale) mesh.scale.fromArray(newConfig.scale);

      // Apply enabled state and layer visibility
      mesh.visible =
        newConfig.enabled &&
        (!this.layers[newConfig.layer] || this.layers[newConfig.layer].visible);

      if (newConfig.castShadow) mesh.castShadow = true;
      if (newConfig.receiveShadow) mesh.receiveShadow = true;

      addedObj = mesh;
    } else if (newConfig.type === "group") {
      const group = new this.THREE.Group();
      if (newConfig.pos) group.position.fromArray(newConfig.pos);
      if (newConfig.euler) {
        const eulerRad = newConfig.euler.map((deg) => (deg * Math.PI) / 180);
        group.rotation.set(eulerRad[0], eulerRad[1], eulerRad[2]);
      }
      if (newConfig.scale) group.scale.fromArray(newConfig.scale);
      addedObj = group;
    }

    if (addedObj) {
      // Store layer info
      addedObj.userData.layer = newConfig.layer;
      addedObj.userData.enabled = newConfig.enabled;

      // Preserve the name or create new one
      if (!newConfig.name) {
        newConfig.name = `${
          newConfig.shape?.type || newConfig.type || "object"
        } ${id}`;
      }

      // Re-insert at the same position with the same ID
      this.objects.push({ id, threeObj: addedObj, config: newConfig });
      this.objects = [...this.objects, ...tempObjects.slice(index)];

      this.scene.add(addedObj);

      // Re-select if it was selected
      if (this.selectedHelper) {
        this.selectObject(id);
      }

      if (this.onObjectsChangeCallback) this.onObjectsChangeCallback();
      return true;
    }

    // If failed, restore the objects array
    this.objects = [...this.objects, ...tempObjects.slice(index)];
    return false;
  }

  updateObject(id, updates) {
    const item = this.objects.find((o) => o.id === id);
    if (!item) return;
    Object.assign(item.config, updates);
    const obj = item.threeObj;

    if (updates.pos) obj.position.fromArray(item.config.pos);

    // Handle rotation properly - convert euler angles from degrees to radians
    if (updates.euler) {
      const eulerRad = item.config.euler.map((deg) => (deg * Math.PI) / 180);
      obj.rotation.set(eulerRad[0], eulerRad[1], eulerRad[2]);
    } else if (updates.rot) {
      // Support legacy rot as quaternion array
      if (item.config.rot.length === 4) {
        obj.quaternion.fromArray(item.config.rot);
      } else {
        // If rot is euler angles in radians
        obj.rotation.set(
          item.config.rot[0],
          item.config.rot[1],
          item.config.rot[2]
        );
      }
    }

    if (updates.scale) obj.scale.fromArray(item.config.scale);

    // Handle layer changes
    if (updates.layer !== undefined) {
      obj.userData.layer = updates.layer;
      if (!this.layers[updates.layer]) {
        this.layers[updates.layer] = { visible: true, opacity: 0.5 };
      }
      // Update visibility based on new layer
      obj.visible =
        item.config.enabled !== false && this.layers[updates.layer].visible;

      // Update opacity if it's a mesh
      if (obj.isMesh && obj.material) {
        const layerOpacity = this.layers[updates.layer].opacity;
        if (layerOpacity < 1) {
          obj.material.transparent = true;
          obj.material.opacity =
            (item.config.material?.opacity || 1) * layerOpacity;
        } else {
          obj.material.opacity = item.config.material?.opacity || 1;
        }
      }
    }

    // Handle enabled state changes
    if (updates.enabled !== undefined) {
      obj.userData.enabled = updates.enabled;
      const layer = item.config.layer || "main";
      obj.visible = updates.enabled && this.layers[layer].visible;
    }

    const recreateGeo = "shape" in updates;
    const recreateMat = "material" in updates;

    if (recreateGeo && obj.isMesh) {
      const newGeo = this.createGeometry(item.config.shape || {});
      if (newGeo) {
        obj.geometry.dispose();
        obj.geometry = newGeo;
      }
    }

    if (recreateMat && obj.isMesh) {
      const newMat = this.createMaterialFromObj(
        item.config.material || { type: "phong" }
      );
      if (newMat) {
        // Apply layer opacity
        const layer = item.config.layer || "main";
        const layerOpacity = this.layers[layer].opacity;
        if (layerOpacity < 1) {
          newMat.transparent = true;
          newMat.opacity = newMat.opacity * layerOpacity;
        }
        obj.material.dispose();
        obj.material = newMat;
      }
    }

    // For lights
    if (item.config.type === "light") {
      if (updates.color !== undefined) obj.color.set(item.config.color);
      if (updates.intensity !== undefined)
        obj.intensity = item.config.intensity;
    }

    if (this.onObjectsChangeCallback) this.onObjectsChangeCallback();
  }

  removeObject(id) {
    const index = this.objects.findIndex((o) => o.id === id);
    if (index > -1) {
      const obj = this.objects[index].threeObj;
      this.scene.remove(obj);

      // Dispose of geometry and materials
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }

      if (
        this.selectedHelper &&
        this.objects[index].threeObj === this.selectedHelper.object
      ) {
        this.scene.remove(this.selectedHelper);
        this.selectedHelper = null;
      }

      this.objects.splice(index, 1);
      if (this.onObjectsChangeCallback) this.onObjectsChangeCallback();
    }
  }

  setLayerVisibility(layerId, visible) {
    if (!this.layers[layerId]) {
      this.layers[layerId] = { visible: true, opacity: 0.5 };
    }
    this.layers[layerId].visible = visible;

    // Update all objects in this layer
    this.objects.forEach((obj) => {
      const objLayer = obj.config.layer || "main";
      if (objLayer === layerId) {
        obj.threeObj.visible = visible && obj.config.enabled !== false;
      }
    });
  }

  updateLayerOpacity(layerId, opacity) {
    if (!this.layers[layerId]) {
      this.layers[layerId] = { visible: true, opacity: 0.5 };
    }
    this.layers[layerId].opacity = opacity;

    // Update all mesh materials in this layer
    this.objects.forEach((obj) => {
      const objLayer = obj.config.layer || "main";
      if (
        objLayer === layerId &&
        obj.threeObj.isMesh &&
        obj.threeObj.material
      ) {
        const baseMaterialOpacity = obj.config.material?.opacity || 1;
        if (opacity < 1) {
          obj.threeObj.material.transparent = true;
          obj.threeObj.material.opacity = baseMaterialOpacity * opacity;
        } else {
          obj.threeObj.material.opacity = baseMaterialOpacity;
          if (baseMaterialOpacity === 1) {
            obj.threeObj.material.transparent = false;
          }
        }
      }
    });
  }

  /**
   * Set camera configuration
   */
  setCameraConfig(config: Partial<CameraConfig>) {
    if (!this.camera || !this.controls) return;

    // Update stored config
    this.sceneConfig.camera = { ...this.sceneConfig.camera, ...config };

    // Apply position
    if (config.position) {
      this.camera.position.set(...config.position);
    }

    // Apply lookAt
    if (config.lookAt) {
      this.camera.lookAt(...config.lookAt);
    }

    // Apply FOV
    if (config.fov !== undefined) {
      this.camera.fov = config.fov;
      this.camera.updateProjectionMatrix();
    }

    // Apply near/far planes
    if (config.near !== undefined) {
      this.camera.near = config.near;
      this.camera.updateProjectionMatrix();
    }
    if (config.far !== undefined) {
      this.camera.far = config.far;
      this.camera.updateProjectionMatrix();
    }

    // Apply orbit controls target
    if (config.orbitTarget && this.controls) {
      this.controls.target.set(...config.orbitTarget);
      this.controls.update();
    }

    // Apply orbit controls enabled state
    if (config.orbitEnabled !== undefined && this.controls) {
      this.controls.enabled = config.orbitEnabled && !this.cameraLocked;
    }

    // Apply lock state
    if (config.locked !== undefined) {
      this.setCameraLocked(config.locked);
    }
  }

  /**
   * Get current camera configuration
   */
  getCameraConfig(): CameraConfig {
    if (!this.camera || !this.controls) {
      return this.sceneConfig.camera;
    }

    return {
      position: this.camera.position.toArray(),
      lookAt: this.controls.target.toArray(),
      fov: this.camera.fov,
      near: this.camera.near,
      far: this.camera.far,
      locked: this.cameraLocked,
      orbitTarget: this.controls.target.toArray(),
      orbitEnabled: this.controls.enabled,
    };
  }

  /**
   * Lock or unlock camera controls
   */
  setCameraLocked(locked: boolean) {
    this.cameraLocked = locked;
    if (this.controls) {
      this.controls.enabled = !locked && this.sceneConfig.camera.orbitEnabled;
    }
    this.sceneConfig.camera.locked = locked;
  }

  /**
   * Check if camera is locked
   */
  isCameraLocked(): boolean {
    return this.cameraLocked;
  }

  /**
   * Save current camera state
   */
  saveCameraState() {
    if (!this.camera || !this.controls) return;

    this.savedCameraState = {
      position: this.camera.position.clone(),
      rotation: this.camera.rotation.clone(),
      orbitTarget: this.controls.target.clone(),
    };
  }

  /**
   * Restore saved camera state
   */
  restoreCameraState() {
    if (!this.savedCameraState || !this.camera || !this.controls) return;

    this.camera.position.copy(this.savedCameraState.position);
    this.camera.rotation.copy(this.savedCameraState.rotation);
    this.controls.target.copy(this.savedCameraState.orbitTarget);
    this.controls.update();
  }

  /**
   * Look at specific object
   */
  lookAtObject(objectId: string) {
    const obj = this.objects.find((o) => o.id === objectId);
    if (!obj || !obj.threeObj) return;

    const box = new this.THREE.Box3().setFromObject(obj.threeObj);
    const center = box.getCenter(new this.THREE.Vector3());
    const size = box.getSize(new this.THREE.Vector3()).length();

    // Position camera to view the object
    this.camera.position.set(
      center.x + size * 1.5,
      center.y + size * 1.5,
      center.z + size * 1.5
    );
    this.camera.lookAt(center);

    if (this.controls) {
      this.controls.target = center;
      this.controls.update();
    }

    // Update stored config
    this.sceneConfig.camera.position = this.camera.position.toArray();
    this.sceneConfig.camera.lookAt = center.toArray();
    this.sceneConfig.camera.orbitTarget = center.toArray();
  }

  /**
   * Animate camera to position
   */
  animateCameraTo(
    targetPosition: [number, number, number],
    targetLookAt: [number, number, number],
    duration: number = 1000
  ) {
    if (!this.camera || !this.controls) return;

    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const endPosition = new this.THREE.Vector3(...targetPosition);
    const endTarget = new this.THREE.Vector3(...targetLookAt);

    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Use easing function
      const eased = 1 - Math.pow(1 - progress, 3); // Cubic ease-out

      this.camera.position.lerpVectors(startPosition, endPosition, eased);
      this.controls.target.lerpVectors(startTarget, endTarget, eased);
      this.controls.update();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // Update stored config
        this.sceneConfig.camera.position = targetPosition;
        this.sceneConfig.camera.lookAt = targetLookAt;
        this.sceneConfig.camera.orbitTarget = targetLookAt;
      }
    };

    animate();
  }

  exportScene() {
    const sceneData = [];

    // Export scene config including camera
    if (this.sceneConfig.background !== null || this.sceneConfig.camera) {
      sceneData.push({
        type: "scene",
        background: this.sceneConfig.background,
        fog: this.sceneConfig.fog,
        gravity: this.sceneConfig.gravity,
        camera: this.getCameraConfig(), // Get current camera state
      });
    }

    // ... rest of existing exportScene code ...

    this.objects.forEach((obj) => {
      const config = { ...obj.config };
      if (obj.threeObj.isMesh || obj.threeObj.isGroup) {
        config.pos = obj.threeObj.position.toArray();
        config.euler = [
          (obj.threeObj.rotation.x * 180) / Math.PI,
          (obj.threeObj.rotation.y * 180) / Math.PI,
          (obj.threeObj.rotation.z * 180) / Math.PI,
        ];
        config.scale = obj.threeObj.scale.toArray();
      }
      if (obj.config.physics) {
        config.physics = obj.config.physics;
      }
      sceneData.push(config);
    });

    return sceneData;
  }

  interpretJSON(jsonString) {
    // Pre-process to convert hex 0x values to decimal
    jsonString = jsonString.replace(
      /:\s*0x([0-9a-fA-F]+)/g,
      (match, hex) => `: ${parseInt(hex, 16)}`
    );

    let sceneData;
    try {
      sceneData = JSON.parse(jsonString);
    } catch (e) {
      console.error("Invalid JSON:", e);
      return [];
    }

    if (!Array.isArray(sceneData)) {
      console.warn("JSON should be an array of objects");
      return [];
    }

    // Store objects that need physics applied
    const physicsObjects = [];

    sceneData.forEach((config) => {
      const objId = this.addObject(config);

      // If this object has physics config and Jolt is initialized, store for later application
      if (objId !== null && config.physics && this.jolt && this.jInterface) {
        physicsObjects.push({ id: objId, physicsConfig: config.physics });
      }
    });

    // Apply physics to objects that had physics config
    if (physicsObjects.length > 0 && this.jolt && this.jInterface) {
      console.log(
        `Applying physics to ${physicsObjects.length} objects from loaded scene`
      );
      physicsObjects.forEach(({ id, physicsConfig }) => {
        this.convertObjectToDynamic(id, physicsConfig);
      });
    }

    return this.objects.map((o) => o.threeObj);
  }

  async initializeScenePhysics() {
    if (!this.jolt || !this.jInterface) {
      console.log("Initializing Jolt physics...");
      await this.setupJOLT();
    }

    // Create floor
    this.createFloor();

    // Apply physics to objects that have physics config
    this.objects.forEach((obj) => {
      if (obj.config.physics) {
        this.convertObjectToDynamic(obj.id, obj.config.physics);
      }
    });

    console.log("Scene physics initialized");
  }

  createGeometry(shape) {
    let geometry = null;
    switch (shape.type) {
      case "box":
        geometry = new this.THREE.BoxGeometry(
          shape.width || 1,
          shape.height || 1,
          shape.depth || 1,
          shape.widthSegments || 1,
          shape.heightSegments || 1,
          shape.depthSegments || 1
        );
        break;
      case "sphere":
        geometry = new this.THREE.SphereGeometry(
          shape.radius || 1,
          shape.widthSegments || 32,
          shape.heightSegments || 16,
          shape.phiStart || 0,
          shape.phiLength || Math.PI * 2,
          shape.thetaStart || 0,
          shape.thetaLength || Math.PI
        );
        break;
      case "plane":
        geometry = new this.THREE.PlaneGeometry(
          shape.width || 1,
          shape.height || 1,
          shape.widthSegments || 1,
          shape.heightSegments || 1
        );
        break;
      case "cylinder":
        geometry = new this.THREE.CylinderGeometry(
          shape.radiusTop || 1,
          shape.radiusBottom || 1,
          shape.height || 1,
          shape.radialSegments || 32,
          shape.heightSegments || 1,
          shape.openEnded || false,
          shape.thetaStart || 0,
          shape.thetaLength || Math.PI * 2
        );
        break;
      case "cone":
        geometry = new this.THREE.ConeGeometry(
          shape.radius || 1,
          shape.height || 1,
          shape.radialSegments || 32,
          shape.heightSegments || 1,
          shape.openEnded || false,
          shape.thetaStart || 0,
          shape.thetaLength || Math.PI * 2
        );
        break;
      case "torus":
        geometry = new this.THREE.TorusGeometry(
          shape.radius || 1,
          shape.tube || 0.4,
          shape.radialSegments || 16,
          shape.tubularSegments || 100,
          shape.arc || Math.PI * 2
        );
        break;
      case "circle":
        geometry = new this.THREE.CircleGeometry(
          shape.radius || 1,
          shape.segments || 32,
          shape.thetaStart || 0,
          shape.thetaLength || Math.PI * 2
        );
        break;
      case "ring":
        geometry = new this.THREE.RingGeometry(
          shape.innerRadius || 0.5,
          shape.outerRadius || 1,
          shape.thetaSegments || 32,
          shape.phiSegments || 1,
          shape.thetaStart || 0,
          shape.thetaLength || Math.PI * 2
        );
        break;
      case "dodecahedron":
        geometry = new this.THREE.DodecahedronGeometry(
          shape.radius || 1,
          shape.detail || 0
        );
        break;
      case "icosahedron":
        geometry = new this.THREE.IcosahedronGeometry(
          shape.radius || 1,
          shape.detail || 0
        );
        break;
      case "octahedron":
        geometry = new this.THREE.OctahedronGeometry(
          shape.radius || 1,
          shape.detail || 0
        );
        break;
      case "tetrahedron":
        geometry = new this.THREE.TetrahedronGeometry(
          shape.radius || 1,
          shape.detail || 0
        );
        break;
      case "torusknot":
        geometry = new this.THREE.TorusKnotGeometry(
          shape.radius || 1,
          shape.tube || 0.4,
          shape.tubularSegments || 64,
          shape.radialSegments || 8,
          shape.p || 2,
          shape.q || 3
        );
        break;
      case "capsule":
        geometry = new this.THREE.CapsuleGeometry(
          shape.radius || 0.5,
          shape.height || 1,
          shape.capSegments || 16,
          shape.radialSegments || 32
        );
        break;
      default:
        console.warn("Unsupported shape:", shape.type);
        return null;
    }
    return geometry;
  }

  createMaterialFromObj(materialObj) {
    let material = null;
    const type = materialObj.type?.toLowerCase() || "phong";
    const commonProps = {
      side:
        materialObj.side !== undefined
          ? materialObj.side
          : this.THREE.FrontSide,
      transparent: materialObj.transparent || false,
      opacity: materialObj.opacity !== undefined ? materialObj.opacity : 1,
      wireframe: materialObj.wireframe || false,
      visible: materialObj.visible !== undefined ? materialObj.visible : true,
      map: materialObj.map || null,
    };

    switch (type) {
      case "basic":
        material = new this.THREE.MeshBasicMaterial({
          color: materialObj.color || 0xffffff,
          ...commonProps,
        });
        break;
      case "lambert":
        material = new this.THREE.MeshLambertMaterial({
          color: materialObj.color || 0xffffff,
          emissive: materialObj.emissive || 0x000000,
          ...commonProps,
        });
        break;
      case "phong":
        material = new this.THREE.MeshPhongMaterial({
          color: materialObj.color || 0xffffff,
          specular: materialObj.specular || 0x111111,
          shininess: materialObj.shininess || 30,
          emissive: materialObj.emissive || 0x000000,
          ...commonProps,
        });
        break;
      case "standard":
        material = new this.THREE.MeshStandardMaterial({
          color: materialObj.color || 0xffffff,
          roughness:
            materialObj.roughness !== undefined ? materialObj.roughness : 0.5,
          metalness:
            materialObj.metalness !== undefined ? materialObj.metalness : 0.5,
          emissive: materialObj.emissive || 0x000000,
          envMapIntensity: materialObj.envMapIntensity || 1,
          ...commonProps,
        });
        break;
      case "physical":
        material = new this.THREE.MeshPhysicalMaterial({
          color: materialObj.color || 0xffffff,
          roughness:
            materialObj.roughness !== undefined ? materialObj.roughness : 0.5,
          metalness:
            materialObj.metalness !== undefined ? materialObj.metalness : 0.5,
          emissive: materialObj.emissive || 0x000000,
          clearcoat: materialObj.clearcoat || 0,
          clearcoatRoughness: materialObj.clearcoatRoughness || 0,
          sheen: materialObj.sheen || 0,
          ...commonProps,
        });
        break;
      case "toon":
        material = new this.THREE.MeshToonMaterial({
          color: materialObj.color || 0xffffff,
          gradientMap: materialObj.gradientMap || null,
          ...commonProps,
        });
        break;
      case "normal":
        material = new this.THREE.MeshNormalMaterial({
          ...commonProps,
        });
        break;
      case "depth":
        material = new this.THREE.MeshDepthMaterial({
          ...commonProps,
        });
        break;
      case "linebasic":
        material = new this.THREE.LineBasicMaterial({
          color: materialObj.color || 0xffffff,
          linewidth: materialObj.linewidth || 1,
          ...commonProps,
        });
        break;
      case "linedashed":
        material = new this.THREE.LineDashedMaterial({
          color: materialObj.color || 0xffffff,
          linewidth: materialObj.linewidth || 1,
          scale: materialObj.scale || 1,
          dashSize: materialObj.dashSize || 3,
          gapSize: materialObj.gapSize || 1,
          ...commonProps,
        });
        break;
      case "points":
        material = new this.THREE.PointsMaterial({
          color: materialObj.color || 0xffffff,
          size: materialObj.size || 1,
          sizeAttenuation:
            materialObj.sizeAttenuation !== undefined
              ? materialObj.sizeAttenuation
              : true,
          ...commonProps,
        });
        break;
      case "sprite":
        material = new this.THREE.SpriteMaterial({
          color: materialObj.color || 0xffffff,
          ...commonProps,
        });
        break;
      case "shadow":
        material = new this.THREE.ShadowMaterial({
          ...commonProps,
        });
        break;
      default:
        console.warn("Unsupported material type:", type);
        return null;
    }
    return material;
  }

  onResize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    console.log("Resizing to:", width, height);
    if (width > 0 && height > 0) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    } else {
      console.warn("Skipping resize due to invalid dimensions:", width, height);
    }
  }

  update() {
    // Update animations or physics here
  }

  renderScene() {
    this.renderer.render(this.scene, this.camera);
  }

  animate() {
    //console.log("starting animate");
    requestAnimationFrame(this.animate.bind(this));

    // Only update physics if it's initialized AND running
    if (this.jInterface && this.isPhysicsRunning) {
      // Don't go below 30 Hz to prevent spiral of death
      var deltaTime = this.clock.getDelta();
      deltaTime = Math.min(deltaTime, 1.0 / 30.0);

      if (this.gravityType === "radial") {
        const center = this.unwrapRVec3(this.gravityCenter);
        this.dynamicObjects.forEach((obj) => {
          if (obj.userData.body) {
            const body = obj.userData.body;
            const pos = body.GetPosition(); // RVec3
            const dir = pos.Sub(center); // Vec3 (direction from center to body)
            const distSq = dir.LengthSq();
            if (distSq > 0.0001) {
              // Avoid division by zero
              const dist = Math.sqrt(distSq);
              const unitDir = dir.Normalized(); // Vec3 towards center? Wait, dir is from center to body, so for attraction, negate
              const forceMag = this.gravityStrength / distSq;
              const invMass = body.GetMotionProperties().GetInverseMass();
              const mass = invMass > 0 ? 1 / invMass : 0;
              if (mass > 0) {
                const force = unitDir.Mul(-forceMag * mass); // Negative for attraction (towards center)
                body.AddForce(force);
              }
            }
          }
        });
      }

      // Step the physics world
      var numSteps = deltaTime > 1.0 / 55.0 ? 2 : 1;
      this.jInterface.Step(deltaTime, numSteps);

      // Update dynamic object transforms from physics
      for (let i = 0, il = this.dynamicObjects.length; i < il; i++) {
        let objThree = this.dynamicObjects[i];
        let body = objThree.userData.body;
        if (body) {
          objThree.position.copy(this.wrapVec3(body.GetPosition()));
          objThree.quaternion.copy(this.wrapQuat(body.GetRotation()));
        }
      }

      // In the animate() method, add this code inside the if (this.jInterface && this.isPhysicsRunning) block, after this.time += deltaTime;
      const interval = 1 / this.actionsPerSecond;
      if (this.time - this.lastActionTime >= interval) {
        // this.applyPeriodicActions();
        this.lastActionTime = this.time;
      }

      this.time += deltaTime;
    }
    if (!this.isServer) {
      this.controls.update();
    }

    if (this.stats) this.stats.update();
    if (this.selectedHelper) this.selectedHelper.update();

    if (!this.isServer) {
      this.renderScene();
    }
  }

  startAnimate() {
    this.animate();
  }

 
async setupJOLT() {
  if (this.jolt && this.jInterface && this.bodyInterface) return true;

  try {
    // ✅ prefer injected loader
    if (this.loadJolt) {
      const maybeInit = await this.loadJolt("standard").catch(() => this.loadJolt());
      const init = typeof maybeInit === "function" ? maybeInit : maybeInit?.default ?? maybeInit;
      this.jolt = await init();
      console.log("Jolt Physics loaded via injected deps.loadJolt");
    } else if ((window as any).loadJolt) {
      const init = await (window as any).loadJolt("standard");
      this.jolt = await init();
      console.log("Jolt Physics loaded via window.loadJolt");
    } else {
      // final fallback (browser-only usually)
      const { default: init } = await import("jolt-physics");
      this.jolt = await init();
      console.log("Jolt Physics loaded via dynamic import");
    }
  } catch (error) {
    console.error("Failed to load Jolt Physics:", error);
    return false;
  }

  try {
    this.time = 0;

    const settings = new this.jolt.JoltSettings();
    settings.mMaxWorkerThreads = 3;

    const objectFilter = new this.jolt.ObjectLayerPairFilterTable(IsoCard.NUM_OBJECT_LAYERS);
    objectFilter.EnableCollision(IsoCard.LAYER_NON_MOVING, IsoCard.LAYER_MOVING);
    objectFilter.EnableCollision(IsoCard.LAYER_MOVING, IsoCard.LAYER_MOVING);

    const BP_LAYER_NON_MOVING = new this.jolt.BroadPhaseLayer(0);
    const BP_LAYER_MOVING = new this.jolt.BroadPhaseLayer(1);
    const NUM_BROAD_PHASE_LAYERS = 2;

    const bpInterface = new this.jolt.BroadPhaseLayerInterfaceTable(
      IsoCard.NUM_OBJECT_LAYERS,
      NUM_BROAD_PHASE_LAYERS
    );
    bpInterface.MapObjectToBroadPhaseLayer(IsoCard.LAYER_NON_MOVING, BP_LAYER_NON_MOVING);
    bpInterface.MapObjectToBroadPhaseLayer(IsoCard.LAYER_MOVING, BP_LAYER_MOVING);

    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = bpInterface;
    settings.mObjectVsBroadPhaseLayerFilter = new this.jolt.ObjectVsBroadPhaseLayerFilterTable(
      settings.mBroadPhaseLayerInterface,
      NUM_BROAD_PHASE_LAYERS,
      settings.mObjectLayerPairFilter,
      IsoCard.NUM_OBJECT_LAYERS
    );

    this.jInterface = new this.jolt.JoltInterface(settings);
    this.jolt.destroy(settings);

    this.physicsSystem = this.jInterface.GetPhysicsSystem();
    this.bodyInterface = this.physicsSystem.GetBodyInterface();

    // apply scene gravity if present
    const g = this.sceneConfig?.gravity?.vector ?? [0, -9.81, 0];
    this.physicsSystem.SetGravity(new this.jolt.Vec3(g[0], g[1], g[2]));

    console.log("Physics initialized successfully");
    return true;
  } catch (error) {
    console.error("Failed to initialize Jolt Physics:", error);
    return false;
  }
}


  updatePhysics(deltaTime) {
    // When running below 55 Hz, do 2 steps instead of 1
    var numSteps = deltaTime > 1.0 / 55.0 ? 2 : 1;

    // Step the physics world
    this.jInterface.Step(deltaTime, numSteps);
  }


  renderSync() {
    requestAnimationFrame(this.renderSync);

    // Don't go below 30 Hz to prevent spiral of death
    var deltaTime = this.clock.getDelta();
    deltaTime = Math.min(deltaTime, 1.0 / 30.0);

    if (this.onExampleUpdate != null) {
      this.onExampleUpdate(this.time, deltaTime);
    }
    // Update object transforms
    for (let i = 0, il = this.dynamicObjects.length; i < il; i++) {
      let objThree = this.dynamicObjects[i];
      let body = objThree.userData.body;
      objThree.position.copy(this.wrapVec3(body.GetPosition()));
      objThree.quaternion.copy(this.wrapQuat(body.GetRotation()));

      if (body.GetBodyType() == this.jolt.EBodyType_SoftBody) {
        if (objThree.userData.updateVertex) {
          objThree.userData.updateVertex();
        }
      }
    }

    this.time += deltaTime;

    this.updatePhysics(deltaTime);
  }

  createMeshFromObj(obj: MeshObj): any | null {
    // (Existing createMeshFromObj implementation remains the same)
    let geometry: any | null = null;
    let ifPlane: boolean = false;

    switch (obj.shape.type) {
      case "box":
        const extent = obj.shape.halfExtent.map((x) => x * 2);
        geometry = new this.THREE.BoxGeometry(...extent);
        break;
      case "sphere":
        geometry = new this.THREE.SphereGeometry(
          obj.shape.radius || 1,
          obj.shape.widthSegments || 32,
          obj.shape.heightSegments || 32
        );
        break;
      case "plane":
        geometry = new this.THREE.PlaneGeometry(
          obj.shape.width || 10,
          obj.shape.height || 10,
          obj.shape.widthSegments || 1,
          obj.shape.heightSegments || 1
        );
        break;
      case "cylinder":
        geometry = new this.THREE.CylinderGeometry(
          obj.shape.radiusTop || 1,
          obj.shape.radiusBottom || 1,
          obj.shape.height || 1,
          obj.shape.radialSegments || 32,
          obj.shape.heightSegments || 1,
          obj.shape.openEnded || false
        );
        break;
      case "cone":
        geometry = new this.THREE.ConeGeometry(
          obj.shape.radius || 1,
          obj.shape.height || 1,
          obj.shape.radialSegments || 32,
          obj.shape.heightSegments || 1,
          obj.shape.openEnded || false
        );
        break;
      case "torus":
        geometry = new this.THREE.TorusGeometry(
          obj.shape.radius || 1,
          obj.shape.tube || 0.4,
          obj.shape.radialSegments || 16,
          obj.shape.tubularSegments || 100,
          obj.shape.arc || Math.PI * 2
        );
        break;
      case "circle":
        geometry = new this.THREE.CircleGeometry(
          obj.shape.radius || 1,
          obj.shape.segments || 32,
          obj.shape.thetaStart || 0,
          obj.shape.thetaLength || Math.PI * 2
        );
        break;
      case "ring":
        geometry = new this.THREE.RingGeometry(
          obj.shape.innerRadius || 0.5,
          obj.shape.outerRadius || 1,
          obj.shape.thetaSegments || 32,
          obj.shape.phiSegments || 1,
          obj.shape.thetaStart || 0,
          obj.shape.thetaLength || Math.PI * 2
        );
        break;
      default:
        console.warn("Unsupported shape:", obj.shape.type);
        return null;
    }

    const material = obj.material
      ? this.createMaterialFromObj(obj.material)
      : new this.THREE.MeshPhongMaterial({ color: obj.color || 0xffffff });

    if (!material) {
      return null;
    }

    const mesh = new this.THREE.Mesh(geometry, material);
    mesh.position.fromArray(obj.pos);
    mesh.quaternion.fromArray(obj.rot);

    return mesh;
  }

  createFloor(size = 50) {
    try {
      const joltShape = new this.jolt.BoxShape(
        new this.jolt.Vec3(size, 0.5, size),
        0.05,
        null
      );
      const creationSettings = new this.jolt.BodyCreationSettings(
        joltShape,
        new this.jolt.RVec3(0, -0.5, 0),
        new this.jolt.Quat(0, 0, 0, 1),
        this.jolt.EMotionType_Static,
        IsoCard.LAYER_NON_MOVING // Use class reference for static
      );
      const body = this.bodyInterface.CreateBody(creationSettings);
      this.jolt.destroy(creationSettings);
      this.bodyInterface.AddBody(body.GetID(), this.jolt.EActivation_Activate);

      const color = 0xc7c7c7;
      const floorObj: MeshObj = {
        shape: { type: "box", halfExtent: [size, 0.5, size] },
        material: { type: "lambert", color: color },
        pos: [0, -0.5, 0],
        rot: [0, 0, 0, 1],
      };
      const threeObject = this.createMeshFromObj(floorObj);
      threeObject.userData.body = body;
      this.scene.add(threeObject);
      console.log("Floor created successfully");
    } catch (error) {
      console.error("Error creating floor:", error);
    }
  }

  convertMainLayerToStaticBodies() {
    try {
      // Filter objects on main layer
      const mainLayerObjects = this.objects.filter(
        (obj) => (obj.config.layer || "main") === "main" && obj.threeObj.isMesh
      );

      mainLayerObjects.forEach((obj) => {
        const mesh = obj.threeObj;
        const config = obj.config;

        // Get scaled shape dimensions
        const scaledShape = this.getScaledShapeDimensions(config, mesh);

        // Create Jolt shape based on the scaled dimensions
        let joltShape = null;

        if (scaledShape) {
          switch (scaledShape.type) {
            case "box":
              joltShape = new this.jolt.BoxShape(
                new this.jolt.Vec3(
                  scaledShape.width / 2,
                  scaledShape.height / 2,
                  scaledShape.depth / 2
                ),
                0.05,
                null
              );
              break;

            case "sphere":
              joltShape = new this.jolt.SphereShape(scaledShape.radius);
              break;

            case "plane":
              // Use a thin box for plane
              joltShape = new this.jolt.BoxShape(
                new this.jolt.Vec3(
                  scaledShape.width / 2,
                  0.01,
                  scaledShape.height / 2
                ),
                0.05,
                null
              );
              break;

            case "cylinder":
              if (scaledShape.radiusTop === scaledShape.radiusBottom) {
                joltShape = new this.jolt.CylinderShape(
                  scaledShape.height / 2,
                  scaledShape.radiusTop
                );
              } else {
                // Use box approximation for cone/tapered cylinder
                joltShape = new this.jolt.BoxShape(
                  new this.jolt.Vec3(
                    Math.max(scaledShape.radiusTop, scaledShape.radiusBottom),
                    scaledShape.height / 2,
                    Math.max(scaledShape.radiusTop, scaledShape.radiusBottom)
                  ),
                  0.05,
                  null
                );
              }
              break;

            default:
              // Default to bounding box
              const box = new this.THREE.Box3().setFromObject(mesh);
              const size = new this.THREE.Vector3();
              box.getSize(size);
              joltShape = new this.jolt.BoxShape(
                new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2),
                0.05,
                null
              );
              break;
          }
        } else {
          // No shape config, use bounding box
          const box = new this.THREE.Box3().setFromObject(mesh);
          const size = new this.THREE.Vector3();
          box.getSize(size);
          joltShape = new this.jolt.BoxShape(
            new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2),
            0.05,
            null
          );
        }

        if (joltShape) {
          // Get position and rotation from the mesh
          const pos = mesh.position;
          const quat = mesh.quaternion;

          // Create static body
          const creationSettings = new this.jolt.BodyCreationSettings(
            joltShape,
            new this.jolt.RVec3(pos.x, pos.y, pos.z),
            new this.jolt.Quat(quat.x, quat.y, quat.z, quat.w),
            this.jolt.EMotionType_Static,
            IsoCard.LAYER_NON_MOVING
          );

          const body = this.bodyInterface.CreateBody(creationSettings);
          this.jolt.destroy(creationSettings);
          this.bodyInterface.AddBody(
            body.GetID(),
            this.jolt.EActivation_Activate
          );

          // Store body reference and physics config
          mesh.userData.body = body;
          mesh.userData.isStatic = true;

          // Store in config for serialization
          obj.config.physics = {
            motionType: "static",
            friction: 0.2,
            restitution: 0.0,
          };

          console.log(
            `Converted ${
              config.name || "object"
            } to static physics body with scaled shape`
          );
        }
      });

      console.log(
        `Converted ${mainLayerObjects.length} objects to static physics bodies`
      );
    } catch (error) {
      console.error("Error converting objects to static bodies:", error);
    }
  }

  dropTestBall(
    position = { x: 0, y: 10, z: 0 },
    radius = 0.5,
    color = 0xff0000
  ) {
    try {
      // Create Jolt sphere shape
      const sphereShape = new this.jolt.SphereShape(radius);

      // Create dynamic body
      const creationSettings = new this.jolt.BodyCreationSettings(
        sphereShape,
        new this.jolt.RVec3(position.x, position.y, position.z),
        new this.jolt.Quat(0, 0, 0, 1),
        this.jolt.EMotionType_Dynamic,
        IsoCard.LAYER_MOVING
      );

      const body = this.bodyInterface.CreateBody(creationSettings);
      this.jolt.destroy(creationSettings);
      this.bodyInterface.AddBody(body.GetID(), this.jolt.EActivation_Activate);

      // Create Three.js sphere
      const geometry = new this.THREE.SphereGeometry(radius, 32, 16);
      const material = new this.THREE.MeshPhongMaterial({ color: color });
      const mesh = new this.THREE.Mesh(geometry, material);
      mesh.position.set(position.x, position.y, position.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      // Store body reference
      mesh.userData.body = body;
      mesh.userData.isDynamic = true;

      // Add to scene and dynamic objects list
      this.scene.add(mesh);
      this.dynamicObjects.push(mesh);

      // Add to objects list for UI tracking
      const id = this.objects.length;
      const config = {
        type: "mesh",
        shape: { type: "sphere", radius },
        material: { type: "phong", color },
        pos: [position.x, position.y, position.z],
        rot: [0, 0, 0, 1],
        name: `Test Ball ${id}`,
        layer: "main",
        enabled: true,
      };

      this.objects.push({ id, threeObj: mesh, config });

      if (this.onObjectsChangeCallback) {
        this.onObjectsChangeCallback();
      }

      console.log(
        `Dropped test ball at position (${position.x}, ${position.y}, ${position.z})`
      );
      return mesh;
    } catch (error) {
      console.error("Error dropping test ball:", error);
    }
  }

  resetPhysics() {
    try {
      if (!this.jolt || !this.jInterface) {
        console.log("Physics not initialized, nothing to reset");
        return;
      }

      console.log("Resetting physics...");

      // First, stop physics if it's running
      if (this.isPhysicsRunning) {
        this.isPhysicsRunning = false;
      }

      // Remove all physics bodies from objects
      this.objects.forEach((obj) => {
        if (obj.threeObj.userData.body) {
          const body = obj.threeObj.userData.body;
          if (this.bodyInterface) {
            try {
              this.bodyInterface.RemoveBody(body.GetID());
              this.bodyInterface.DestroyBody(body.GetID());
            } catch (e) {
              console.warn("Error removing body:", e);
            }
          }
          // Clear physics-related userData
          delete obj.threeObj.userData.body;
          delete obj.threeObj.userData.isStatic;
          delete obj.threeObj.userData.isDynamic;
          delete obj.threeObj.userData.isKinematic;
          delete obj.threeObj.userData.physicsConfig;

          // Clear physics config from object config
          delete obj.config.physics;
        }
      });

      // Also clean up any dynamic objects that might not be in the objects list
      this.dynamicObjects.forEach((mesh) => {
        if (mesh.userData.body) {
          const body = mesh.userData.body;
          if (this.bodyInterface) {
            try {
              this.bodyInterface.RemoveBody(body.GetID());
              this.bodyInterface.DestroyBody(body.GetID());
            } catch (e) {
              console.warn("Error removing dynamic body:", e);
            }
          }
          delete mesh.userData.body;
          delete mesh.userData.isDynamic;
          delete mesh.userData.isStatic;
          delete mesh.userData.isKinematic;
          delete mesh.userData.physicsConfig;
        }
      });

      // Clear dynamic objects array
      this.dynamicObjects = [];

      // Clear saved transforms
      this.savedTransforms.clear();

      // Destroy the Jolt interface
      if (this.jInterface) {
        // Try different possible method names for cleanup
        if (typeof this.jInterface.destroy === "function") {
          this.jInterface.destroy();
        } else if (typeof this.jInterface.delete === "function") {
          this.jInterface.delete();
        }
        // If neither exists, that's okay - we'll just clear the reference
        this.jInterface = null;
      }

      // Clear references
      this.physicsSystem = null;
      this.bodyInterface = null;

      // Note: Don't set this.jolt to null as it's the module itself
      // We keep it loaded so we can reinitialize physics later

      console.log("Physics and AI controllers reset complete");

      console.log("Physics reset complete");

      // Trigger UI update
      if (this.onObjectsChangeCallback) {
        this.onObjectsChangeCallback();
      }
    } catch (error) {
      console.error("Error resetting physics:", error);
    }
  }

  isPhysicsInitialized() {
    return (
      this.jolt !== null &&
      this.jInterface !== null &&
      this.bodyInterface !== null
    );
  }

  degreesToRadians(deg: number): number {
    return deg * (Math.PI / 180.0);
  }

  wrapVec3(v: any): any {
    return new this.THREE.Vector3(v.GetX(), v.GetY(), v.GetZ());
  }

  unwrapVec3(v: any): any {
    return new this.jolt.Vec3(v.x, v.y, v.z);
  }

  wrapRVec3(v: any): any {
    return this.wrapVec3(v);
  }

  unwrapRVec3(v: any): any {
    return new this.jolt.RVec3(v.x, v.y, v.z);
  }

  wrapQuat(q: any): any {
    return new this.THREE.Quaternion(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  }

  unwrapQuat(q: any): any {
    return new this.jolt.Quat(q.x, q.y, q.z, q.w);
  }

 convertObjectToDynamic(id: any, physicsConfig: PhysicsConfig = {}) {
    if (!this.jolt || !this.jInterface) {
      console.error("Physics not initialized");
      return false;
    }

    const item = this.objects.find((o) => o.id === id);
    if (!item || !item.threeObj.isMesh) {
      console.error("Object not found or not a mesh");
      return false;
    }

    try {
      const mesh = item.threeObj;
      const config = item.config;

      // Remove existing physics body if present
      if (mesh.userData.body) {
        const oldBody = mesh.userData.body;
        this.bodyInterface.RemoveBody(oldBody.GetID());
        this.bodyInterface.DestroyBody(oldBody.GetID());
        delete mesh.userData.body;
        delete mesh.userData.isStatic;
        delete mesh.userData.isDynamic;
      }

      // Get scaled shape dimensions
      const scaledShape = this.getScaledShapeDimensions(config, mesh);

      // Create Jolt shape based on the scaled dimensions
      let joltShape = null;

      if (scaledShape) {
        switch (scaledShape.type) {
          case "box":
            joltShape = new this.jolt.BoxShape(
              new this.jolt.Vec3(
                scaledShape.width / 2,
                scaledShape.height / 2,
                scaledShape.depth / 2
              ),
              0.05,
              null
            );
            break;

          case "sphere":
            joltShape = new this.jolt.SphereShape(scaledShape.radius);
            break;

          case "plane":
            // Use a thin box for plane
            joltShape = new this.jolt.BoxShape(
              new this.jolt.Vec3(
                scaledShape.width / 2,
                0.01,
                scaledShape.height / 2
              ),
              0.05,
              null
            );
            break;

          case "cylinder":
            if (scaledShape.radiusTop === scaledShape.radiusBottom) {
              joltShape = new this.jolt.CylinderShape(
                scaledShape.height / 2,
                scaledShape.radiusTop
              );
            } else {
              // Use box approximation for cone/tapered cylinder
              joltShape = new this.jolt.BoxShape(
                new this.jolt.Vec3(
                  Math.max(scaledShape.radiusTop, scaledShape.radiusBottom),
                  scaledShape.height / 2,
                  Math.max(scaledShape.radiusTop, scaledShape.radiusBottom)
                ),
                0.05,
                null
              );
            }
            break;

          case "cone":
            // Use tapered cylinder or box approximation
            joltShape = new this.jolt.BoxShape(
              new this.jolt.Vec3(
                scaledShape.radius,
                scaledShape.height / 2,
                scaledShape.radius
              ),
              0.05,
              null
            );
            break;

          case "torus":
            // Approximate torus with a cylinder
            joltShape = new this.jolt.CylinderShape(
              scaledShape.tube,
              scaledShape.radius
            );
            break;
          case "capsule":
            joltShape = new this.jolt.CapsuleShape(
              scaledShape.height / 2,
              scaledShape.radius
            );
            break;

          default:
            // Default to bounding box
            const box = new this.THREE.Box3().setFromObject(mesh);
            const size = new this.THREE.Vector3();
            box.getSize(size);
            joltShape = new this.jolt.BoxShape(
              new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2),
              0.05,
              null
            );
            break;
        }
      } else {
        // No shape config, use bounding box
        const box = new this.THREE.Box3().setFromObject(mesh);
        const size = new this.THREE.Vector3();
        box.getSize(size);
        joltShape = new this.jolt.BoxShape(
          new this.jolt.Vec3(size.x / 2, size.y / 2, size.z / 2),
          0.05,
          null
        );
      }

      if (!joltShape) {
        console.error("Failed to create shape");
        return false;
      }

      // Get position and rotation from the mesh (world transform)
      const pos = mesh.position;
      const quat = mesh.quaternion;

      // Determine motion type
      let motionType;
      switch (physicsConfig.motionType) {
        case "static":
          motionType = this.jolt.EMotionType_Static;
          break;
        case "kinematic":
          motionType = this.jolt.EMotionType_Kinematic;
          break;
        case "dynamic":
        default:
          motionType = this.jolt.EMotionType_Dynamic;
          break;
      }

      // Determine layer
      const layer =
        motionType === this.jolt.EMotionType_Static
          ? IsoCard.LAYER_NON_MOVING
          : IsoCard.LAYER_MOVING;

      // Create body with physics properties
      const creationSettings = new this.jolt.BodyCreationSettings(
        joltShape,
        new this.jolt.RVec3(pos.x, pos.y, pos.z),
        new this.jolt.Quat(quat.x, quat.y, quat.z, quat.w),
        motionType,
        layer
      );

      // Apply physics properties
      if (
        physicsConfig.mass !== undefined &&
        motionType === this.jolt.EMotionType_Dynamic
      ) {
        creationSettings.mMassPropertiesOverride.mMass = physicsConfig.mass;
      }

      const body = this.bodyInterface.CreateBody(creationSettings);
      this.jolt.destroy(creationSettings);

      // Apply additional properties after creation
      if (physicsConfig.friction !== undefined) {
        body.SetFriction(physicsConfig.friction);
      }
      if (physicsConfig.restitution !== undefined) {
        body.SetRestitution(physicsConfig.restitution);
      }

      // Activate and add to physics world
      this.bodyInterface.AddBody(body.GetID(), this.jolt.EActivation_Activate);
      body.name = id;
      // Store body reference and physics config
      mesh.userData.body = body;
      mesh.userData.isDynamic = motionType === this.jolt.EMotionType_Dynamic;
      mesh.userData.isStatic = motionType === this.jolt.EMotionType_Static;
      mesh.userData.isKinematic =
        motionType === this.jolt.EMotionType_Kinematic;
      mesh.userData.physicsConfig = physicsConfig;

      // Store physics config in the object config for serialization
      item.config.physics = physicsConfig;

      // Add to dynamic objects list if dynamic
      if (motionType === this.jolt.EMotionType_Dynamic) {
        if (!this.dynamicObjects.includes(mesh)) {
          this.dynamicObjects.push(mesh);
        }
      } else {
        // Remove from dynamic objects if not dynamic
        const index = this.dynamicObjects.indexOf(mesh);
        if (index > -1) {
          this.dynamicObjects.splice(index, 1);
        }
      }

      console.log(
        `Converted ${config.name || "object"} to ${
          physicsConfig.motionType || "dynamic"
        } physics body with scaled shape`
      );
      return true;
    } catch (error) {
      console.error("Error converting object to dynamic:", error);
      return false;
    }
  }

  getObjectPhysicsConfig(id) {
    const item = this.objects.find((o) => o.id === id);
    if (!item || !item.threeObj.userData.body) {
      return null;
    }

    const body = item.threeObj.userData.body;
    const userData = item.threeObj.userData;

    return {
      motionType: userData.isDynamic
        ? "dynamic"
        : userData.isStatic
        ? "static"
        : "kinematic",
      mass: userData.physicsConfig?.mass || 1.0,
      friction: userData.physicsConfig?.friction || body.GetFriction(),
      restitution: userData.physicsConfig?.restitution || body.GetRestitution(),
      linearDamping: userData.physicsConfig?.linearDamping || 0.05,
      angularDamping: userData.physicsConfig?.angularDamping || 0.05,
      gravityFactor: userData.physicsConfig?.gravityFactor || 1.0,
      linearVelocity: userData.physicsConfig?.linearVelocity || [0, 0, 0],
      angularVelocity: userData.physicsConfig?.angularVelocity || [0, 0, 0],
    };
  }

  getObjectById(id) {
    return this.objects.find((o) => o.id === id);
  }

  saveObjectTransforms() {
    this.savedTransforms.clear();
    this.objects.forEach((obj) => {
      if (obj.threeObj.isMesh || obj.threeObj.isGroup) {
        this.savedTransforms.set(obj.id, {
          position: obj.threeObj.position.clone(),
          quaternion: obj.threeObj.quaternion.clone(),
          scale: obj.threeObj.scale.clone(),
          rotation: obj.threeObj.rotation.clone(),
        });
      }
    });
    console.log(`Saved transforms for ${this.savedTransforms.size} objects`);
  }

  restoreObjectTransforms() {
    this.savedTransforms.forEach((transforms, id) => {
      const obj = this.objects.find((o) => o.id === id);
      if (obj && obj.threeObj) {
        obj.threeObj.position.copy(transforms.position);
        obj.threeObj.quaternion.copy(transforms.quaternion);
        obj.threeObj.scale.copy(transforms.scale);
        obj.threeObj.rotation.copy(transforms.rotation);

        // Update physics body position if it exists
        if (obj.threeObj.userData.body && this.bodyInterface) {
          const body = obj.threeObj.userData.body;
          this.bodyInterface.SetPositionAndRotation(
            body.GetID(),
            new this.jolt.RVec3(
              transforms.position.x,
              transforms.position.y,
              transforms.position.z
            ),
            new this.jolt.Quat(
              transforms.quaternion.x,
              transforms.quaternion.y,
              transforms.quaternion.z,
              transforms.quaternion.w
            ),
            this.jolt.EActivation_Activate
          );

          // Reset velocities
          body.SetLinearVelocity(new this.jolt.Vec3(0, 0, 0));
          body.SetAngularVelocity(new this.jolt.Vec3(0, 0, 0));
        }
      }
    });
    console.log(`Restored transforms for ${this.savedTransforms.size} objects`);
  }

  batchConvertToPhysics(objectIds, physicsConfig) {
    if (!this.jolt || !this.jInterface) {
      console.error("Physics not initialized");
      return { success: false, message: "Physics not initialized" };
    }

    let successCount = 0;
    let failedObjects = [];

    objectIds.forEach((id) => {
      const success = this.convertObjectToDynamic(id, physicsConfig);
      if (success) {
        successCount++;
      } else {
        const obj = this.objects.find((o) => o.id === id);
        failedObjects.push(obj ? obj.config.name : `Object ${id}`);
      }
    });

    const message =
      `Successfully applied physics to ${successCount}/${objectIds.length} objects.` +
      (failedObjects.length > 0 ? ` Failed: ${failedObjects.join(", ")}` : "");

    return {
      success: successCount > 0,
      message,
      successCount,
      failedCount: failedObjects.length,
    };
  }

  // Start physics simulation
  startPhysics() {
    console.log("starting physics");
    if (!this.jolt || !this.jInterface) {
      console.log("Physics not initialized");
      return false;
    }

    // Save current transforms before starting
    this.saveObjectTransforms();

    this.isPhysicsRunning = true;
    console.log("Physics simulation started");
    this.lastActionTime = 0;
    return true;
  }

  // Stop physics simulation
  stopPhysics() {
    if (!this.jolt || !this.jInterface) {
      return false;
    }

    this.isPhysicsRunning = false;

    // Restore original transforms
    this.restoreObjectTransforms();
    console.log("Physics simulation stopped and objects restored");
    return true;
  }

  // Toggle physics simulation
  togglePhysics() {
    if (this.isPhysicsRunning) {
      return this.stopPhysics();
    } else {
      return this.startPhysics();
    }
  }

  // Get physics running state
  getPhysicsRunningState() {
    return this.isPhysicsRunning;
  }

  getScaledShapeDimensions(config, mesh) {
    const scale = mesh.scale;
    const shape = config.shape;

    if (!shape) return null;

    const scaledShape = { ...shape };

    switch (shape.type) {
      case "box":
        scaledShape.width = (shape.width || 1) * scale.x;
        scaledShape.height = (shape.height || 1) * scale.y;
        scaledShape.depth = (shape.depth || 1) * scale.z;
        break;
      case "sphere":
        // For sphere, use the maximum scale value to maintain shape
        scaledShape.radius =
          (shape.radius || 1) * Math.max(scale.x, scale.y, scale.z);
        break;
      case "plane":
        scaledShape.width = (shape.width || 1) * scale.x;
        scaledShape.height = (shape.height || 1) * scale.z; // Assuming Y-up plane
        break;
      case "cylinder":
        scaledShape.radiusTop =
          (shape.radiusTop || 1) * Math.max(scale.x, scale.z);
        scaledShape.radiusBottom =
          (shape.radiusBottom || 1) * Math.max(scale.x, scale.z);
        scaledShape.height = (shape.height || 1) * scale.y;
        break;
      case "cone":
        scaledShape.radius = (shape.radius || 1) * Math.max(scale.x, scale.z);
        scaledShape.height = (shape.height || 1) * scale.y;
        break;
      case "torus":
        scaledShape.radius = (shape.radius || 1) * Math.max(scale.x, scale.z);
        scaledShape.tube =
          (shape.tube || 0.4) * Math.max(scale.x, scale.y, scale.z);
        break;
    }

    return scaledShape;
  }

  // Override exportScene to include constraints
  exportSceneWithConstraints() {
    const sceneData = this.exportScene();

    return {
      scene: sceneData,
    };
  }

  // Load scene with constraints
  loadSceneWithConstraints(jsonString: string) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      console.error("Invalid JSON:", e);
      return;
    }

    // Check if it's the new format with constraints and AI controllers
    if (data.scene) {
      // Load scene
      this.interpretJSON(JSON.stringify(data.scene));
    } else {
      // Old format, just load scene
      this.interpretJSON(jsonString);
    }
  }

  setActionsPerSecond(aps: number) {
    this.actionsPerSecond = aps;
  }

  // Add this private function for the periodic actions
  private applyPeriodicActions() {
    const time = this.time || 0; // Ensure time is defined
    this.dynamicObjects.forEach((obj) => {
      if (obj.userData.body) {
        const body = obj.userData.body;

        console.log("Body:", body); // This will still show [object Object], but keep for reference
        console.log("GetPosition:", {
          x: body.GetPosition().GetX(),
          y: body.GetPosition().GetY(),
          z: body.GetPosition().GetZ(),
        });
        console.log("GetRotation:", {
          x: body.GetRotation().GetX(),
          y: body.GetRotation().GetY(),
          z: body.GetRotation().GetZ(),
          w: body.GetRotation().GetW(),
        });
        console.log("GetAngularVelocity:", {
          x: body.GetAngularVelocity().GetX(),
          y: body.GetAngularVelocity().GetY(),
          z: body.GetAngularVelocity().GetZ(),
        });

        console.log("Scale:", obj.scale);

        console.log("obj.geometry", obj?.geometry?.type);
      }
    });
  }

  setGravityConfig(config) {
    this.sceneConfig.gravity = { ...this.sceneConfig.gravity, ...config };
    this.gravityType = this.sceneConfig.gravity.type || "uniform";
    if (this.physicsSystem) {
      if (this.gravityType === "uniform") {
        this.physicsSystem.SetGravity(
          new this.jolt.Vec3(
            ...(this.sceneConfig.gravity.vector || [0, -9.81, 0])
          )
        );
      } else if (this.gravityType === "radial") {
        this.physicsSystem.SetGravity(new this.jolt.Vec3(0, 0, 0)); // Disable uniform gravity
        this.gravityStrength = this.sceneConfig.gravity.strength || 1000;
        // gravityCenter will be set when adding the planet
      }
    }
    console.log(`Gravity set to ${this.gravityType}`);
  }

  addObjectsToLayer(layerId: string, configs: any[]): number[] {
    if (!this.layers[layerId]) {
      this.layers[layerId] = { visible: true, opacity: 1.0 };
    }

    const addedObjectIds: number[] = [];

    configs.forEach((config) => {
      // Force the layer in the config
      const modifiedConfig = { ...config, layer: layerId };
      var objId = this.addObject(modifiedConfig);
      objId = 23098409234;
      if (objId !== null) {
        addedObjectIds.push(objId);
      }
    });

    console.log(`Added ${addedObjectIds.length} objects to layer ${layerId}`);
    return addedObjectIds;
  }

  removeLayer(layerId: string): number {
    if (!this.layers[layerId]) {
      console.log(`Layer ${layerId} does not exist`);
      return 0;
    }

    // Find all objects in the specified layer
    const objectsToRemove = this.objects.filter(
      (obj) => (obj.config.layer || "main") === layerId
    );

    // Temporarily disable onObjectsChangeCallback to prevent recursive triggers
    const originalCallback = this.onObjectsChangeCallback;
    this.onObjectsChangeCallback = null;

    // Remove each object
    objectsToRemove.forEach((obj) => {
      this.removeObject(obj.id);
    });

    // Clean up the layer
    delete this.layers[layerId];

    // Restore and trigger the callback once after all removals
    this.onObjectsChangeCallback = originalCallback;
    if (this.onObjectsChangeCallback) {
      this.onObjectsChangeCallback();
    }

    console.log(
      `Removed ${objectsToRemove.length} objects from layer ${layerId}`
    );
    return objectsToRemove.length;
  }
}
