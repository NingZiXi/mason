import { computed, ref, shallowRef } from "vue";
import { defineStore } from "pinia";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export const useUpdaterStore = defineStore("updater", () => {
  const update = shallowRef<Update | null>(null);
  const status = ref<"idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "ready">("idle");
  const error = ref("");
  const downloaded = ref(0);
  const total = ref(0);
  const busy = computed(() => ["checking", "downloading", "installing"].includes(status.value));
  const progress = computed(() => total.value > 0
    ? Math.min(100, Math.round(downloaded.value / total.value * 100)) : 0);

  async function checkForUpdates() {
    if (busy.value || status.value === "ready") return;
    status.value = "checking";
    error.value = "";
    try {
      const next = await check({ timeout: 15000 });
      const previous = update.value;
      update.value = next;
      status.value = next ? "available" : "latest";
      await previous?.close().catch(() => {});
    } catch (e) {
      error.value = String(e);
      status.value = update.value ? "available" : "idle";
    }
  }

  async function restart() {
    if (status.value !== "ready") return;
    error.value = "";
    try {
      await relaunch();
    } catch (e) {
      // Installation already succeeded. Keep the restart action available.
      error.value = String(e);
    }
  }

  async function installUpdate() {
    if (!update.value || busy.value || status.value === "ready") return;
    status.value = "downloading";
    error.value = "";
    downloaded.value = 0;
    total.value = 0;
    try {
      // Separate download/verification from installation so a failed signature
      // never advances the UI to the installation stage.
      await update.value.download((event) => {
        if (event.event === "Started") total.value = event.data.contentLength ?? 0;
        if (event.event === "Progress") downloaded.value += event.data.chunkLength;
      }, { timeout: 600000 });
      status.value = "installing";
      await update.value.install();
      // Windows exits into the installer; macOS/Linux need an explicit restart.
      status.value = "ready";
      await restart();
    } catch (e) {
      error.value = String(e);
      status.value = "available";
    }
  }

  return { update, status, error, downloaded, total, busy, progress, checkForUpdates, installUpdate, restart };
});
