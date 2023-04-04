/* eslint-disable @typescript-eslint/no-unused-vars */
// import Axios from "axios";
import { ChainsService } from "../chains";
import { PermissionService } from "../permission";
import { TendermintTxTracer } from "@keplr-wallet/cosmos";
import { Notification } from "./types";

import { Buffer } from "buffer/";

import { createNymMixnetClient } from "@nymproject/sdk-commonjs";

interface CosmosSdkError {
  codespace: string;
  code: number;
  message: string;
}

interface ABCIMessageLog {
  msg_index: number;
  success: boolean;
  log: string;
  // Events StringEvents
}

export class BackgroundTxService {
  protected chainsService!: ChainsService;
  public permissionService!: PermissionService;

  constructor(protected readonly notification: Notification) {}

  init(chainsService: ChainsService, permissionService: PermissionService) {
    this.chainsService = chainsService;
    this.permissionService = permissionService;
  }

  async sendTx(
    chainId: string,
    tx: unknown,
    _: "async" | "sync" | "block"
  ): Promise<Uint8Array> {
    const chainInfo = await this.chainsService.getChainInfo(chainId);
    console.log("tx >>>>>>>>>>>> ", { tx });

    // SNIP >>> ----- this should happen after log in and be attached to some global context -----

    // start the web worker
    const nym = await createNymMixnetClient();

    // initialise
    console.log("Let's go, Nym!");

    const nymApiUrl = "https://validator.nymtech.net/api";
    await nym.client.start({ nymApiUrl, clientId: "Keplr wallet" });

    nym.events.subscribeToConnected((e) => {
      console.log("address >>>>>> ", e.args.address);
    });

    // sleep to allow the client to start up
    await new Promise((resolve) => setTimeout(resolve, 5000));
    // <<< SNIP ----------------------------------------------------------------------------------

    const message = JSON.stringify({
      tx,
      returnAddress: await nym.client.selfAddress(),
    });

    const recipient =
      "9fmWwtBFzpPLijLnNhSNUfTeHfrpQB6YBrGhnKrrRKdz.9GP5LBEXV2reCVCh5v6R3K1yzk5r2KToyC9JMuq5Agpz@2BuMSfMW3zpeAjKXyKLhmY4QW1DXurrtSPEJ6CjX3SEh";

    const sendTxViaMixnet = async (): Promise<string> =>
      new Promise(async (res, _) => {
        try {
          console.log(`Sending to  ${recipient} through mixnet >>>>>`, tx);
          await nym.client.send({
            payload: { message, mimeType: "text/plain" },
            recipient,
          });
          await nym.events.subscribeToTextMessageReceivedEvent((e) => {
            console.log("Received tx hash: ", e.args.payload);

            res(e.args.payload);
          });
        } catch (e) {
          console.log("error >>>>", e);
        }
      });

    const txHash = await sendTxViaMixnet();

    // const restInstance = Axios.create({
    //   ...{
    //     baseURL: chainInfo.rest,
    //   },
    //   ...chainInfo.restConfig,
    // });

    // console.log("Waiting for response");
    // nym.events.subscribeToTextMessageReceivedEvent((e) => {
    //   console.log(e.args.payload);
    //   res(e.args.payload);
    // });

    // restInstance.interceptors.request.use(async function (config) {
    //   console.log(config);

    // });

    this.notification.create({
      iconRelativeUrl: "assets/logo-256.png",
      title: "Tx is pending...",
      message: "Wait a second",
    });

    // const isProtoTx = Buffer.isBuffer(tx) || tx instanceof Uint8Array;

    // const params = isProtoTx
    //   ? {
    //       tx_bytes: Buffer.from(tx as any).toString("base64"),
    //       mode: (() => {
    //         switch (mode) {
    //           case "async":
    //             return "BROADCAST_MODE_ASYNC";
    //           case "block":
    //             return "BROADCAST_MODE_BLOCK";
    //           case "sync":
    //             return "BROADCAST_MODE_SYNC";
    //           default:
    //             return "BROADCAST_MODE_UNSPECIFIED";
    //         }
    //       })(),
    //     }
    //   : {
    //       tx,
    //       mode: mode,
    //     };

    try {
      // const result = await restInstance.post(
      //   isProtoTx ? "/cosmos/tx/v1beta1/txs" : "/txs",
      //   {}
      // );

      // const txResponse = isProtoTx ? result.data["tx_response"] : result.data;

      // if (txResponse.code != null && txResponse.code !== 0) {
      //   throw new Error(txResponse["raw_log"]);
      // }

      const txHashAsBuffer = Buffer.from(txHash, "hex");

      const txTracer = new TendermintTxTracer(chainInfo.rpc, "/websocket");
      txTracer.traceTx(txHashAsBuffer).then((tx) => {
        txTracer.close();
        BackgroundTxService.processTxResultNotification(this.notification, tx);
      });

      return txHashAsBuffer;
    } catch (e) {
      console.log(e);
      BackgroundTxService.processTxErrorNotification(this.notification, e);
      throw e;
    }
  }

  private static processTxResultNotification(
    notification: Notification,
    result: any
  ): void {
    try {
      if (result.mode === "commit") {
        if (result.checkTx.code !== undefined && result.checkTx.code !== 0) {
          throw new Error(result.checkTx.log);
        }
        if (
          result.deliverTx.code !== undefined &&
          result.deliverTx.code !== 0
        ) {
          throw new Error(result.deliverTx.log);
        }
      } else {
        if (result.code != null && result.code !== 0) {
          // XXX: Hack of the support of the stargate.
          const log = result.log ?? (result as any)["raw_log"];
          throw new Error(log);
        }
      }

      notification.create({
        iconRelativeUrl: "assets/logo-256.png",
        title: "Tx succeeds",
        // TODO: Let users know the tx id?
        message: "Congratulations!",
      });
    } catch (e) {
      BackgroundTxService.processTxErrorNotification(notification, e);
    }
  }

  private static processTxErrorNotification(
    notification: Notification,
    e: Error
  ): void {
    console.log(e);
    let message = e.message;

    // Tendermint rpc error.
    const regResult = /code:\s*(-?\d+),\s*message:\s*(.+),\sdata:\s(.+)/g.exec(
      e.message
    );
    if (regResult && regResult.length === 4) {
      // If error is from tendermint
      message = regResult[3];
    }

    try {
      // Cosmos-sdk error in ante handler
      const sdkErr: CosmosSdkError = JSON.parse(e.message);
      if (sdkErr?.message) {
        message = sdkErr.message;
      }
    } catch {
      // noop
    }

    try {
      // Cosmos-sdk error in processing message
      const abciMessageLogs: ABCIMessageLog[] = JSON.parse(e.message);
      if (abciMessageLogs && abciMessageLogs.length > 0) {
        for (const abciMessageLog of abciMessageLogs) {
          if (!abciMessageLog.success) {
            const sdkErr: CosmosSdkError = JSON.parse(abciMessageLog.log);
            if (sdkErr?.message) {
              message = sdkErr.message;
              break;
            }
          }
        }
      }
    } catch {
      // noop
    }

    notification.create({
      iconRelativeUrl: "assets/logo-256.png",
      title: "Tx failed",
      message,
    });
  }
}
