export {};

declare global {
  interface Window {
    faceapi?: any;
    loadPlayer?: (options: {
      url: string;
      canvas: HTMLCanvasElement;
      audio?: boolean;
      disableGl?: boolean;
    }) => Promise<any>;
  }
}
