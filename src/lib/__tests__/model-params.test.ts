import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConfigStore } from "../../stores/config";
import { buildScadParams, modelParamsHash, scadPartHash } from "../model-params";
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
  it("invalidates only the affected jig parts while preserving shared fit dependencies", () => {
    const params = buildScadParams(useConfigStore().config);
    const nut = { ...params, nut_pocket_clearance: 0.4 };
    expect(scadPartHash(nut, "insert")).toBe(scadPartHash(params, "insert"));
    expect(scadPartHash(nut, "cover")).toBe(scadPartHash(params, "cover"));
    expect(scadPartHash(nut, "base")).not.toBe(scadPartHash(params, "base"));
    const fit = { ...params, post_clearance: 0.5 };
    expect(scadPartHash(fit, "insert")).toBe(scadPartHash(params, "insert"));
    expect(scadPartHash(fit, "base")).not.toBe(scadPartHash(params, "base"));
    expect(scadPartHash(fit, "cover")).not.toBe(scadPartHash(params, "cover"));
    // Cover thickness also controls the tray's locating-post height.
    expect(scadPartHash({ ...params, top_cover_height: 9 }, "insert")).not.toBe(scadPartHash(params, "insert"));
  });
  it("keeps jig meshes when only stencil apertures change and keeps the opposite stencil side", () => {
    const store = useConfigStore();
    const before = buildScadParams(store.config);
    store.config.padShrink = 10;
    store.config.stencilPadsTop = extractPads(paste).pads;
    const after = buildScadParams(store.config);
    expect(scadPartHash(after, "insert")).toBe(scadPartHash(before, "insert"));
    expect(scadPartHash(after, "stencil_top")).not.toBe(scadPartHash(before, "stencil_top"));
    expect(scadPartHash({ ...after, stencil_pads_top: [] }, "stencil_bottom")).toBe(scadPartHash(after, "stencil_bottom"));
    expect(scadPartHash({ ...after, nut_pocket_clearance: 0.5 }, "stencil_top")).toBe(scadPartHash(after, "stencil_top"));
    expect(scadPartHash({ ...after, stencil_corner_radius: 9 }, "base")).not.toBe(scadPartHash(after, "base"));
  });
  it("passes nut pocket clearance to the engine and invalidates cached geometry", () => {
    const store = useConfigStore();
    expect(buildScadParams(store.config).nut_pocket_clearance).toBe(0.2);
    const before = modelParamsHash(store.config);
    store.config.nutPocketClearance = 0.35;
    expect(buildScadParams(store.config).nut_pocket_clearance).toBe(0.35);
    expect(modelParamsHash(store.config)).not.toBe(before);
    expect(store.config.nutAcrossFlats).toBe(5.5);
  });
  it("enables test point filtering by default and invalidates the model when shape metadata changes", () => {
    const store = useConfigStore();
    expect(buildScadParams(store.config).stencil_filter_test_points).toBe(true);
    store.config.stencilPadsTop = extractPads(paste).pads;
    const before = modelParamsHash(store.config);
    store.config.stencilPadsTop[0].type = "circle";
    expect(modelParamsHash(store.config)).not.toBe(before);
    expect(buildScadParams(store.config).stencil_pads_top[0].type).toBe("circle");
  });
  it("transports X2 pad roles and invalidates cached geometry when a role changes", () => {
    const store = useConfigStore();
    store.config.stencilPadsTop = extractPads(paste).pads;
    const before = modelParamsHash(store.config);
    store.config.stencilPadsTop[0].padRole = "component";
    expect(modelParamsHash(store.config)).not.toBe(before);
    const params = JSON.parse(JSON.stringify(buildScadParams(store.config)));
    expect(params.stencil_pads_top[0].padRole).toBe("component");
  });
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
      expect(result).toEqual(pads.map(({ type, polarity, parts }) => ({ type, polarity, parts })));
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
