import { defineStore } from "pinia";
import { ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { SkillDto } from "../net/types";

/** 技能索引（内置引擎 N5/N6）：只读扫描，重扫即重新读目录。 */
export type SkillsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export const useSkillsStore = defineStore("skills", () => {
  const skills = ref<SkillDto[]>([]);
  const dir = ref("");
  const status = ref<SkillsStatus>("idle");
  const errorText = ref("");

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      const res = await api.skills(signal);
      skills.value = res.skills;
      dir.value = res.dir;
      status.value = res.skills.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        skills.value = [];
        status.value = "empty";
        return;
      }
      skills.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取技能失败";
    }
  }

  async function rescan(): Promise<number> {
    const res = await api.rescanSkills();
    skills.value = res.skills;
    dir.value = res.dir;
    status.value = res.skills.length === 0 ? "empty" : "ready";
    return res.skills.length;
  }

  return { skills, dir, status, errorText, load, rescan };
});
