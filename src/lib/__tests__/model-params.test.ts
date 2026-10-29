import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../../stores/config";
import { buildScadParams, modelParamsHash } from "../model-params";
import { extractPads } from "../gerber/pads";

beforeEach(() => setActivePinia(createPinia()));

// A dark opening followed by a clear flash that restores material inside it.
const paste = `%FSLAX24Y24*%
%MOMM*%
%ADD10R,6X6*%
%ADD11R,2X2*%
%LPD*%
D10*
X0Y0D03*
%LPC*%
D11*
X0Y0D03*
M02*`;

describe("CAD parameter boundary", () => {
  it.each(["stencilPadsTop", "stencilPadsBottom"] as const)(
    "preserves image and part polarity through JSON for %s",
    (side) => {
      const store = useConfigStore();
      const pads = extractPads(paste).pads;
      expect(pads.map((pad) => pad.polarity)).toEqual(["D", "C"]);
      // Include a macro-style clear part and a hole as well as image-level LPC.
      pads[0].parts.push({ polarity: "C", points: pads[1].parts[0].points });
      pads[0].parts[0].holes = [pads[1].parts[0].points];
      store.config[side] = pads;
      const params = JSON.parse(JSON.stringify(buildScadParams(store.config)));
      const result = params[side === "stencilPadsTop" ? "stencil_pads_top" : "stencil_pads_bottom"];
      expect(result).toEqual(pads.map(({ polarity, parts }) => ({ polarity, parts })));
    }
  );

  it.each(["stencilPadsTop", "stencilPadsBottom"] as const)(
    "invalidates cached geometry when only %s image polarity changes",
    (side) => {
      const store = useConfigStore();
      store.config[side] = extractPads(paste).pads;
      const before = modelParamsHash(store.config);
      store.config[side] = store.config[side].map((pad) => ({ ...pad, polarity: "D" }));
      expect(modelParamsHash(store.config)).not.toBe(before);
    }
  );
});
