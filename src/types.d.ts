// file: src/types.d.ts (new file)
declare module 'jolt-physics' {
  const init: any;
  export default init;
}

declare global {
  interface Window {
    loadJolt?: (type?: string) => Promise<any>;
    Stats?: any;
    OrbitControls?: any;
    THREE?: any;
  }
}
export {};
