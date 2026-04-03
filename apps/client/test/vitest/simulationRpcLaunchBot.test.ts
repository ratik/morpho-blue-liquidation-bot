import type { ChainConfig } from "@morpho-blue-liquidation-bot/config";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createWalletClientMock,
  httpMock,
  privateKeyToAccountMock,
  liquidatonBotRunMock,
  liquidatonBotWarmupPricingMock,
  liquidatonBotRefreshPricerCachesMock,
} = vi.hoisted(() => ({
  createWalletClientMock: vi.fn(),
  httpMock: vi.fn((url: string) => ({ url })),
  privateKeyToAccountMock: vi.fn(() => ({
    address: "0x0000000000000000000000000000000000000002",
  })),
  liquidatonBotRunMock: vi.fn(),
  liquidatonBotWarmupPricingMock: vi.fn(),
  liquidatonBotRefreshPricerCachesMock: vi.fn(),
}));

let lastBotInputs: unknown;

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createWalletClient: createWalletClientMock,
    http: httpMock,
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: privateKeyToAccountMock,
}));

vi.mock("../../src/bot.js", () => ({
  LiquidationBot: class {
    constructor(inputs: unknown) {
      lastBotInputs = inputs;
    }

    run = liquidatonBotRunMock;
    warmupData = liquidatonBotWarmupPricingMock;
    refreshPricerCaches = liquidatonBotRefreshPricerCachesMock;
  },
}));

import { launchBot } from "../../src/index.js";

function createConfig(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chain: base,
    chainId: base.id,
    rpcUrl: "https://main-rpc.example",
    simulationRpcUrl: "https://simulation-rpc.example",
    wNative: "0x4200000000000000000000000000000000000006",
    vaultWhitelist: ["0x0000000000000000000000000000000000000003"],
    additionalMarketsWhitelist: [],
    liquidityVenues: [],
    pricers: undefined,
    treasuryAddress: undefined,
    liquidationBufferBps: undefined,
    useFlashbots: false,
    pollingIntervalMs: 10_000,
    dataProvider: "morphoApi",
    executorAddress: "0x0000000000000000000000000000000000000004",
    liquidationPrivateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    ...overrides,
  };
}

describe("launchBot simulation client", () => {
  beforeEach(() => {
    lastBotInputs = undefined;
    createWalletClientMock.mockReset();
    httpMock.mockClear();
    privateKeyToAccountMock.mockClear();
    liquidatonBotRunMock.mockReset();
    liquidatonBotWarmupPricingMock.mockReset();
    liquidatonBotRefreshPricerCachesMock.mockReset();
    vi.useFakeTimers();

    createWalletClientMock
      .mockReturnValueOnce({
        account: { address: "0x0000000000000000000000000000000000000002" },
        chain: base,
      })
      .mockReturnValueOnce({
        account: { address: "0x0000000000000000000000000000000000000002" },
        chain: base,
      });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a separate simulation client when simulationRpcUrl is configured", async () => {
    liquidatonBotWarmupPricingMock.mockResolvedValue(undefined);
    liquidatonBotRunMock.mockResolvedValue(undefined);

    await launchBot(createConfig(), {} as never);

    expect(httpMock).toHaveBeenNthCalledWith(1, "https://main-rpc.example");
    expect(httpMock).toHaveBeenNthCalledWith(2, "https://simulation-rpc.example");
    expect(createWalletClientMock).toHaveBeenCalledTimes(2);
    expect(liquidatonBotWarmupPricingMock).toHaveBeenCalledTimes(1);
    expect((lastBotInputs as { client: object; simulationClient: object }).client).not.toBe(
      (lastBotInputs as { client: object; simulationClient: object }).simulationClient,
    );
  });

  it("falls back to the main RPC when simulationRpcUrl is unset", async () => {
    liquidatonBotWarmupPricingMock.mockResolvedValue(undefined);
    liquidatonBotRunMock.mockResolvedValue(undefined);

    await launchBot(createConfig({ simulationRpcUrl: undefined }), {} as never);

    expect(httpMock).toHaveBeenNthCalledWith(1, "https://main-rpc.example");
    expect(httpMock).toHaveBeenNthCalledWith(2, "https://main-rpc.example");
    expect(createWalletClientMock).toHaveBeenCalledTimes(2);
  });

  it("runs immediately on startup and schedules the next polling iteration", async () => {
    liquidatonBotWarmupPricingMock.mockResolvedValue(undefined);
    liquidatonBotRunMock.mockResolvedValue(undefined);

    await launchBot(createConfig({ pollingIntervalMs: 50 }), {} as never);
    expect(liquidatonBotRunMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(liquidatonBotRunMock).toHaveBeenCalledTimes(2);
  });

  it("does not start overlapping runs when a tick lands during an active run", async () => {
    liquidatonBotWarmupPricingMock.mockResolvedValue(undefined);
    liquidatonBotRunMock.mockImplementation(
      () =>
        new Promise<void>(() => {
          return undefined;
        }),
    );

    await launchBot(createConfig({ pollingIntervalMs: 50 }), {} as never);
    expect(liquidatonBotRunMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(150);
    expect(liquidatonBotRunMock).toHaveBeenCalledTimes(1);
  });

  it("waits for warmup before starting polling", async () => {
    let resolveWarmup: (() => void) | undefined;
    liquidatonBotWarmupPricingMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWarmup = resolve;
        }),
    );
    liquidatonBotRunMock.mockResolvedValue(undefined);

    const launchPromise = launchBot(createConfig({ pollingIntervalMs: 50 }), {} as never);
    await Promise.resolve();
    expect(liquidatonBotRunMock).not.toHaveBeenCalled();

    resolveWarmup?.();
    await launchPromise;
    expect(liquidatonBotRunMock).toHaveBeenCalledTimes(1);
  });
});
