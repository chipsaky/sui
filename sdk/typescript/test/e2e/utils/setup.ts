// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'vitest';
import { execSync } from 'child_process';
import tmp from 'tmp';

import {
  Ed25519Keypair,
  getPublishedObjectChanges,
  getExecutionStatusType,
  JsonRpcProvider,
  fromB64,
  localnetConnection,
  Connection,
  Coin,
  TransactionBlock,
  RawSigner,
  FaucetResponse,
  assert,
  SuiAddress,
  ObjectId,
  normalizeSuiObjectId,
  FaucetRateLimitError,
} from '../../../src';
import { retry } from 'ts-retry-promise';

const TEST_ENDPOINTS = localnetConnection;
const DEFAULT_FAUCET_URL =
  import.meta.env.VITE_FAUCET_URL ?? TEST_ENDPOINTS.faucet;
const DEFAULT_FULLNODE_URL =
  import.meta.env.VITE_FULLNODE_URL ?? TEST_ENDPOINTS.fullnode;
const SUI_BIN = import.meta.env.VITE_SUI_BIN ?? 'cargo run --bin sui';

export const DEFAULT_RECIPIENT =
  '0x0c567ffdf8162cb6d51af74be0199443b92e823d4ba6ced24de5c6c463797d46';
export const DEFAULT_RECIPIENT_2 =
  '0xbb967ddbebfee8c40d8fdd2c24cb02452834cd3a7061d18564448f900eb9e66d';
export const DEFAULT_GAS_BUDGET = 10000;
export const DEFAULT_SEND_AMOUNT = 1000;

export class TestToolbox {
  keypair: Ed25519Keypair;
  provider: JsonRpcProvider;
  signer: RawSigner;

  constructor(keypair: Ed25519Keypair, provider: JsonRpcProvider) {
    this.keypair = keypair;
    this.provider = provider;
    this.signer = new RawSigner(this.keypair, this.provider);
  }

  address() {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  // TODO(chris): replace this with provider.getCoins instead
  async getGasObjectsOwnedByAddress() {
    const objects = await this.provider.getOwnedObjects({
      owner: this.address(),
      options: {
        showType: true,
        showContent: true,
        showOwner: true,
      },
    });
    return objects.data.filter((obj) => Coin.isSUI(obj));
  }

  public async getActiveValidators() {
    return (await this.provider.getLatestSuiSystemState()).activeValidators;
  }
}

export function getProvider(): JsonRpcProvider {
  return new JsonRpcProvider(
    new Connection({
      fullnode: DEFAULT_FULLNODE_URL,
      faucet: DEFAULT_FAUCET_URL,
    }),
    {
      skipDataValidation: false,
    },
  );
}

export async function setup() {
  const keypair = Ed25519Keypair.generate();
  const address = keypair.getPublicKey().toSuiAddress();
  const provider = getProvider();
  const resp = await retry(() => provider.requestSuiFromFaucet(address), {
    backoff: 'EXPONENTIAL',
    // overall timeout in 60 seconds
    timeout: 1000 * 60,
    // skip retry if we hit the rate-limit error
    retryIf: (error: any) => !(error instanceof FaucetRateLimitError),
    logger: (msg) => console.warn('Retrying requesting from faucet: ' + msg),
  });
  assert(resp, FaucetResponse);
  return new TestToolbox(keypair, provider);
}

export async function publishPackage(
  packagePath: string,
  toolbox?: TestToolbox,
) {
  // TODO: We create a unique publish address per publish, but we really could share one for all publishes.
  if (!toolbox) {
    toolbox = await setup();
  }

  // remove all controlled temporary objects on process exit
  tmp.setGracefulCleanup();

  const tmpobj = tmp.dirSync({ unsafeCleanup: true });

  const compiledModulesAndDeps = JSON.parse(
    execSync(
      `${SUI_BIN} move build --dump-bytecode-as-base64 --path ${packagePath} --install-dir ${tmpobj.name}`,
      { encoding: 'utf-8' },
    ),
  );
  const tx = new TransactionBlock();
  // TODO: Publish dry runs fail currently, so we need to set a gas budget:
  tx.setGasBudget(10000);

  const cap = tx.publish(
    compiledModulesAndDeps.modules.map((m: any) => Array.from(fromB64(m))),
    compiledModulesAndDeps.dependencies.map((addr: string) =>
      normalizeSuiObjectId(addr),
    ),
  );

  // Transfer the upgrade capability to the sender so they can upgrade the package later if they want.
  tx.transferObjects([cap], tx.pure(await toolbox.signer.getAddress()));

  const publishTxn = await toolbox.signer.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });
  expect(getExecutionStatusType(publishTxn)).toEqual('success');

  const packageId = getPublishedObjectChanges(publishTxn)[0].packageId.replace(
    /^(0x)(0+)/,
    '0x',
  );
  expect(packageId).toBeTruthy();

  console.info(
    `Published package ${packageId} from address ${await toolbox.signer.getAddress()}}`,
  );

  return { packageId, publishTxn };
}

export function getRandomAddresses(n: number): SuiAddress[] {
  return Array(n)
    .fill(null)
    .map(() => {
      const keypair = Ed25519Keypair.generate();
      return keypair.getPublicKey().toSuiAddress();
    });
}

// TODO: shall we move the transaction builder part to Transaction.ts?
export async function paySui(
  signer: RawSigner,
  numRecipients: number = 1,
  recipients?: SuiAddress[],
  amounts?: number[],
  coinId?: ObjectId,
) {
  const tx = new TransactionBlock();

  recipients = recipients ?? getRandomAddresses(numRecipients);
  amounts = amounts ?? Array(numRecipients).fill(DEFAULT_SEND_AMOUNT);

  expect(
    recipients.length === amounts.length,
    'recipients and amounts must be the same length',
  );

  coinId =
    coinId ??
    (
      await signer.provider.getCoins({
        owner: await signer.getAddress(),
        coinType: '0x2::sui::SUI',
      })
    ).data[0].coinObjectId;

  recipients.forEach((recipient, i) => {
    const coin = tx.splitCoins(tx.object(coinId!), [tx.pure(amounts![i])]);
    tx.transferObjects([coin], tx.pure(recipient));
  });

  const txn = await signer.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    options: {
      showEffects: true,
      showObjectChanges: true,
    },
  });
  expect(getExecutionStatusType(txn)).toEqual('success');
  return txn;
}

export async function executePaySuiNTimes(
  signer: RawSigner,
  nTimes: number,
  numRecipientsPerTxn: number = 1,
  recipients?: SuiAddress[],
  amounts?: number[],
) {
  const txns = [];
  for (let i = 0; i < nTimes; i++) {
    // must await here to make sure the txns are executed in order
    txns.push(await paySui(signer, numRecipientsPerTxn, recipients, amounts));
  }
  return txns;
}
