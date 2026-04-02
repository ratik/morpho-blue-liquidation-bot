import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBlockNumberMock, getGasPriceMock, simulateCallsMock, writeContractMock } = vi.hoisted(
  () => ({
    getBlockNumberMock: vi.fn(),
    getGasPriceMock: vi.fn(),
    simulateCallsMock: vi.fn(),
    writeContractMock: vi.fn(),
  }),
);

vi.mock("viem/actions", async () => {
  const actual = await vi.importActual<typeof import("viem/actions")>("viem/actions");
  return {
    ...actual,
    getBlockNumber: getBlockNumberMock,
    getGasPrice: getGasPriceMock,
    simulateCalls: simulateCallsMock,
    writeContract: writeContractMock,
  };
});

import { LiquidationBot } from "../../src/bot.js";

interface HandleTxContext {
  client: { account: { address: Address } };
  simulationClient: { account: { address: Address } };
  flashbotAccount?: undefined;
  logTag: string;
  checkProfit: () => Promise<boolean>;
  logger: { error: ReturnType<typeof vi.fn> };
}

describe("handleTx simulation client routing", () => {
  beforeEach(() => {
    getBlockNumberMock.mockReset();
    getGasPriceMock.mockReset();
    simulateCallsMock.mockReset();
    writeContractMock.mockReset();
  });

  it("uses the simulation client only for simulateCalls", async () => {
    const mainClient = {
      account: { address: "0x0000000000000000000000000000000000000001" as Address },
    };
    const simulationClient = {
      account: { address: "0x0000000000000000000000000000000000000002" as Address },
    };

    simulateCallsMock.mockResolvedValue({
      results: [
        { result: 1n, status: "success" },
        { gasUsed: 1n, result: "0x", status: "success" },
        { result: 2n, status: "success" },
      ],
    });
    getGasPriceMock.mockResolvedValue(1n);
    writeContractMock.mockResolvedValue("0x1234");

    const success = await (
      LiquidationBot.prototype as unknown as {
        handleTx: (
          this: HandleTxContext,
          encoder: { address: Address },
          calls: Hex[],
          marketParams: {
            loanToken: Address;
            collateralToken: Address;
            oracle: Address;
            irm: Address;
            lltv: bigint;
          },
          badDebtPosition: boolean,
        ) => Promise<boolean | undefined>;
      }
    ).handleTx.call(
      {
        client: mainClient,
        simulationClient,
        logTag: "[test] ",
        checkProfit: vi.fn().mockResolvedValue(true),
        logger: { error: vi.fn() },
      },
      { address: "0x0000000000000000000000000000000000000003" as Address },
      ["0x1234" as Hex],
      {
        loanToken: "0x0000000000000000000000000000000000000004" as Address,
        collateralToken: "0x0000000000000000000000000000000000000005" as Address,
        oracle: "0x0000000000000000000000000000000000000006" as Address,
        irm: "0x0000000000000000000000000000000000000007" as Address,
        lltv: 1n,
      },
      false,
    );

    expect(success).toBe(true);
    expect(simulateCallsMock).toHaveBeenCalledWith(
      simulationClient,
      expect.objectContaining({
        account: mainClient.account.address,
      }),
    );
    expect(getGasPriceMock).toHaveBeenCalledWith(mainClient);
    expect(writeContractMock).toHaveBeenCalledWith(
      mainClient,
      expect.objectContaining({
        address: "0x0000000000000000000000000000000000000003",
      }),
    );
  });
});
