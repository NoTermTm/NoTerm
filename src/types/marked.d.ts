declare module "marked" {
  export const marked: {
    parse: (content: string, options?: Record<string, unknown>) => string;
    Renderer: new () => {
      code: (code: string, infostring?: string) => string;
    };
  };
}
