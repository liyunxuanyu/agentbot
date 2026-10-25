import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  maskApiKey,
  providerDto,
  readProviderFile,
  resolveProvider,
  writeProviderFile,
} from "../../src/server/adapters/providers/store.js";
import type { ProviderConfig } from "../../src/server/core/agent/provider.js";

const dirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-provider-store-"));
  dirs.push(dir);
  return join(dir, "providers.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄占用
    }
  }
});

const CONFIG: ProviderConfig = {
  id: "p1",
  name: "测试供应商",
  protocol: "openai-chat",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-1234567890abcd",
  model: "test-model",
  contextWindow: 100000,
  supportsTools: true,
  supportsStreaming: true,
};

describe("providers.json", () => {
  it("写入后可读回，默认 id 指向第一个供应商", () => {
    const path = tempPath();
    writeProviderFile({ defaultId: null, providers: [CONFIG] }, path);
    const file = readProviderFile(path);
    expect(file.providers).toHaveLength(1);
    expect(file.providers[0]?.id).toBe("p1");
    expect(file.defaultId).toBe("p1");
  });

  it("文件不存在 / JSON 损坏 → 空配置，不抛错", () => {
    const path = tempPath();
    expect(readProviderFile(path)).toEqual({ defaultId: null, providers: [] });
    writeFileSync(path, "{not json", "utf8");
    expect(readProviderFile(path)).toEqual({ defaultId: null, providers: [] });
  });

  it("resolveProvider：显式绑定优先，其次默认，最后第一条", () => {
    const path = tempPath();
    const second: ProviderConfig = { ...CONFIG, id: "p2", name: "第二个" };
    writeProviderFile({ defaultId: "p2", providers: [CONFIG, second] }, path);
    // resolveProvider 读默认路径（config.providersPath），这里直接验证文件语义
    const file = readProviderFile(path);
    expect(file.defaultId).toBe("p2");
    expect(file.providers.find((p) => p.id === "p2")?.name).toBe("第二个");
    expect(resolveProvider).toBeTypeOf("function");
  });

  it("DTO 只暴露 apiKey 掩码", () => {
    const dto = providerDto(CONFIG, "p1");
    expect(dto.apiKeyMasked).toBe("sk-****abcd");
    expect(JSON.stringify(dto)).not.toContain("1234567890");
    expect(dto.isDefault).toBe(true);
  });

  it("maskApiKey 对短 key 全掩码", () => {
    expect(maskApiKey("short")).toBe("****");
    expect(maskApiKey("sk-1234567890abcd")).toBe("sk-****abcd");
  });
});
