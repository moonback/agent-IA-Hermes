import { createRequire } from 'node:module';
import { registerSecret } from '../shared/redact';

export interface SecretStore {
  readonly kind: string;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

const SERVICE = 'HERMES';

type KeyringModule = typeof import('@napi-rs/keyring');

/**
 * OS credential vault (Windows Credential Manager, macOS Keychain, Secret Service on Linux)
 * through the @napi-rs/keyring native binding.
 */
export class KeyringSecretStore implements SecretStore {
  readonly kind = 'os-keyring';
  private readonly Entry: KeyringModule['Entry'];

  constructor() {
    // Loaded lazily so a missing native binding degrades to an explicit error instead of a crash at import.
    const require = createRequire(import.meta.url);
    this.Entry = (require('@napi-rs/keyring') as KeyringModule).Entry;
  }

  async get(name: string): Promise<string | null> {
    const v = new this.Entry(SERVICE, name).getPassword();
    registerSecret(v);
    return v ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    registerSecret(value);
    new this.Entry(SERVICE, name).setPassword(value);
  }

  async delete(name: string): Promise<boolean> {
    return new this.Entry(SERVICE, name).deletePassword();
  }
}

/** In-memory store for tests only. */
export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    registerSecret(value);
    this.values.set(name, value);
  }
  async delete(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}

/** Environment variables take precedence (development), then the vault. */
export class LayeredSecretStore implements SecretStore {
  readonly kind: string;

  constructor(
    private readonly vault: SecretStore,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.kind = vault.kind;
  }

  source(name: string): 'env' | 'vault' {
    return this.env[name] ? 'env' : 'vault';
  }

  async get(name: string): Promise<string | null> {
    const fromEnv = this.env[name];
    if (fromEnv) {
      registerSecret(fromEnv);
      return fromEnv;
    }
    return this.vault.get(name);
  }
  set(name: string, value: string): Promise<void> {
    return this.vault.set(name, value);
  }
  delete(name: string): Promise<boolean> {
    return this.vault.delete(name);
  }
}
