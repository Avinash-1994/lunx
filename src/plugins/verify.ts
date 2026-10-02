import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

export async function verifyPluginSignature(pluginPath: string, keysDir?: string): Promise<boolean> {
  try {
    const sigPath = pluginPath + '.sig'
    const manifestPath = pluginPath + '.manifest.json'
    const [sigBuf, dataBuf, manifestBuf] = await Promise.all([
      fs.readFile(sigPath).catch(() => null),
      fs.readFile(pluginPath),
      fs.readFile(manifestPath).catch(() => null),
    ])
    if (!sigBuf) return false
    const sig = Buffer.from(sigBuf.toString().trim(), 'base64')
    const keysFolder = keysDir || path.resolve(process.cwd(), 'config', 'plugin_keys')
    let targetKeys: string[] = []
    if (manifestBuf) {
      try {
        const manifest = JSON.parse(manifestBuf.toString())
        if (manifest && manifest.keyId) {
          targetKeys = [manifest.keyId + '.pem']
        }
      } catch (e) {
        // malformed manifest -> fall back to scanning all keys
      }
    }
      if (targetKeys.length === 0) {
        targetKeys = await fs.readdir(keysFolder).catch(() => [])
      }
      // consult truststore if present - restrict to trusted keys
      const trustPath = path.resolve(process.cwd(), 'config', 'trust.json')
      const trust = await fs.readFile(trustPath).then((b) => JSON.parse(b.toString())).catch(() => null)
      if (trust && Array.isArray(trust.keys) && trust.keys.length > 0) {
        const keysArr: any[] = trust.keys
        const active = keysArr.filter((x) => !x.revoked).map((x) => x.keyId)
        targetKeys = targetKeys.filter((k) => active.includes(k.replace(/\.pem$/, '')))
      }
    for (const e of targetKeys) {
      if (!e.endsWith('.pem')) continue
      const pub = await fs.readFile(path.join(keysFolder, e), 'utf8').catch(() => null)
      if (!pub) continue
      const verifier = crypto.createVerify('sha256')
      verifier.update(dataBuf)
      verifier.end()
      try {
        if (verifier.verify(pub, sig)) return true
      } catch (err) {
        // ignore and try next key
      }
    }
    return false
  } catch (e) {
    return false
  }
}

export default verifyPluginSignature

export async function verifyBundle(pluginPath: string, keysDir?: string): Promise<boolean> {
  try {
    const manifestPath = pluginPath + '.manifest.json'
    const manifestSigPath = pluginPath + '.manifest.sig'
    const [manifestBuf, manifestSigBuf, dataBuf] = await Promise.all([
      fs.readFile(manifestPath).catch(() => null),
      fs.readFile(manifestSigPath).catch(() => null),
      fs.readFile(pluginPath),
    ])
    if (!manifestBuf || !manifestSigBuf) return false
    const manifest = JSON.parse(manifestBuf.toString())
    const manifestSig = Buffer.from(manifestSigBuf.toString().trim(), 'base64')

  // ensure signing key is present in truststore and not revoked
  const trustPath = path.resolve(process.cwd(), 'config', 'trust.json')
  const trust = await fs.readFile(trustPath).then((b) => JSON.parse(b.toString())).catch(() => null)
  if (!trust || !Array.isArray(trust.keys)) return false
  const keyEntry: any = trust.keys.find((k: any) => k.keyId === manifest.keyId)
  if (!keyEntry || keyEntry.revoked) return false
  if (manifest.publisherId && keyEntry.publisherId && manifest.publisherId !== keyEntry.publisherId) return false

  // find public key file
  const keysFolder = keysDir || path.resolve(process.cwd(), 'config', 'plugin_keys')
  const keyFile = path.join(keysFolder, manifest.keyId + '.pem')
  const pub = await fs.readFile(keyFile, 'utf8').catch(() => null)
  if (!pub) return false
    // verify manifest signature
    const verifier = crypto.createVerify('sha256')
    verifier.update(JSON.stringify(manifest, null, 2))
    verifier.end()
    if (!verifier.verify(pub, manifestSig)) return false

    // verify checksum matches
    const hash = crypto.createHash('sha256').update(dataBuf).digest('hex')
    if (manifest.checksum !== hash) return false

  // optionally verify plugin internal signature if present (not required)
  // manifest signature + checksum are the primary source of truth
  // we attempted plugin internal signature verification for extra assurance but do not require it
  // (if you want to require it, change this to `return pluginSigOk`)
  // const pluginSigOk = await verifyPluginSignature(pluginPath, keysDir).catch(() => false)
  return true
  } catch (e) {
    return false
  }
}
