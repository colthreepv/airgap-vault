// Generates the fixed signing requests used by run.mjs.
// Run from the app checkout root so its node_modules resolve:
//   node e2e/android-insets/fixtures/generate.cjs
// It rewrites requests.json next to this file (UTF-8, independent of the shell).
// The mnemonic is the public BIP39 test vector; never use it for real funds.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { EthereumProtocol } = require('@airgap/ethereum/v0')
const { EthereumModule } = require('@airgap/ethereum')
const { MainProtocolSymbols } = require('@airgap/coinlib-core')
const { IACMessageType, Message, SerializerV3 } = require('@airgap/serializer')
const { UR, UREncoder } = require('@ngraveio/bc-ur')
const bs58check = require('bs58check')

const MNEMONIC = `${Array(11).fill('abandon').join(' ')} about`
// Vault creates Ethereum accounts as HD wallets and matches requests by the
// account's extended public key, which AirGap Wallet also sends.
const DERIVATION_PATH = "m/44'/60'/0'"
const SCHEME = 'airgap-vault://'

async function toDeeplink(message) {
  const serialized = await SerializerV3.getInstance().serialize([message])
  const decoded = await SerializerV3.getInstance().deserialize(serialized)
  if (!decoded.deserialize?.[0]?.ok) throw decoded.deserialize?.[0]?.error ?? new Error('request does not round-trip')
  const ur = UR.fromBuffer(bs58check.decode(serialized))
  const part = new UREncoder(ur, Number.MAX_SAFE_INTEGER).nextPart()
  const data = (part.match(/([^/]+$)/) ?? [part])[0].toUpperCase()
  return `${SCHEME}?ur=${data}`
}

async function main() {
  // Register Ethereum's serializer schemas the same way Vault does at startup.
  const companion = await new EthereumModule().createV3SerializerCompanion()
  companion.schemas.forEach((configuration) => {
    SerializerV3.addSchema(configuration.type, configuration.schema, configuration.protocolIdentifier)
  })

  const protocol = new EthereumProtocol()
  const publicKey = await protocol.getExtendedPublicKeyFromMnemonic(MNEMONIC, DERIVATION_PATH)
  const address = (await protocol.getAddressFromExtendedPublicKey(publicKey, 0, 0)).address

  const messageRequest = new Message(IACMessageType.MessageSignRequest, MainProtocolSymbols.ETH, {
    message: 'AirGap Vault inset regression test. Do not sign anywhere else.',
    publicKey,
    callbackURL: 'airgap-wallet://?d='
  }, 247001)
  const transactionRequest = new Message(IACMessageType.TransactionSignRequest, MainProtocolSymbols.ETH, {
    publicKey,
    transaction: {
      nonce: '0x00',
      gasPrice: '0x3b9aca00',
      gasLimit: '0x5208',
      to: address,
      value: '0x00',
      chainId: 1,
      data: '0x'
    },
    callbackURL: 'airgap-wallet://?d='
  }, 247002)

  const out = {
    mnemonic: MNEMONIC,
    derivationPath: DERIVATION_PATH,
    protocol: MainProtocolSymbols.ETH,
    publicKey,
    address,
    signMessage: await toDeeplink(messageRequest),
    signTransaction: await toDeeplink(transactionRequest)
  }
  const file = join(__dirname, 'requests.json')
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log('wrote ' + file + ' for ' + address)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
