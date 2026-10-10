export interface View {
  xmin: number;
  xmax: number;
  ymin: number | null;
  ymax: number | null;
}

export interface Series {
  id: string;
  kind: "fn" | "implicit" | "param" | "data";
  label: string;
  color: string;
  dynamic: boolean;
  style: "line" | "points";
  xs?: (number | null)[];
  ys?: (number | null)[];
  segs?: number[];
}

export interface PlotSpec {
  id: number;
  title: string;
  series: Series[];
  view: View;
  hold: boolean;
}

export type ToKernel =
  | { type: "run"; id: number; code: string }
  | { type: "input"; value?: string; eof?: boolean }
  | { type: "sample"; reqId: number; ids: string[]; view: Required<{ [K in keyof View]: number }>; n: number };

export type FromKernel =
  | { type: "status"; text: string }
  | {
      type: "ready";
      kernel?: "native" | "pyodide";
      version: string;
      python: string;
      ms: number;
      executable?: string;
      missing?: string[];
    }
  | { type: "fatal"; text: string }
  | { type: "stdout"; id: number; text: string }
  | { type: "stderr"; id: number; text: string }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number; text: string }
  | { type: "image"; id: number; src: string }
  | { type: "plot"; id: number; plot: PlotSpec }
  | { type: "help"; id: number }
  | { type: "input_request"; id: number; prompt: string }
  | { type: "done"; id: number; ok: boolean; ms: number }
  | { type: "samples"; reqId: number; series: Series[] };
