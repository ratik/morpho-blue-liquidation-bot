import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSecrets } from "../../../config/src/index.js";

describe("simulation RPC config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns simulationRpcUrl when configured", () => {
    vi.stubEnv("RPC_URL_8453", "https://main-rpc.example");
    vi.stubEnv("SIMULATION_RPC_URL_8453", "https://simulation-rpc.example");
    vi.stubEnv("EXECUTOR_ADDRESS_8453", "0x0000000000000000000000000000000000000001");
    vi.stubEnv(
      "LIQUIDATION_PRIVATE_KEY_8453",
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );

    const secrets = getSecrets(base.id, base);

    expect(secrets.rpcUrl).toBe("https://main-rpc.example");
    expect(secrets.simulationRpcUrl).toBe("https://simulation-rpc.example");
  });

  it("leaves simulationRpcUrl undefined when unset", () => {
    vi.stubEnv("RPC_URL_8453", "https://main-rpc.example");
    vi.stubEnv("EXECUTOR_ADDRESS_8453", "0x0000000000000000000000000000000000000001");
    vi.stubEnv(
      "LIQUIDATION_PRIVATE_KEY_8453",
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );

    const secrets = getSecrets(base.id, base);

    expect(secrets.rpcUrl).toBe("https://main-rpc.example");
    expect(secrets.simulationRpcUrl).toBeUndefined();
  });
});
