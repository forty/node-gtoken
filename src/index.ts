// Copyright 2022 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import {GaxiosError, request} from 'gaxios';
import * as jws from 'jws';
import * as path from 'path';
import {promisify} from 'util';

const readFile = fs.readFile
  ? promisify(fs.readFile)
  : async () => {
      // if running in the web-browser, fs.readFile may not have been shimmed.
      throw new ErrorWithCode(
        'use key rather than keyFile.',
        'MISSING_CREDENTIALS'
      );
    };

const GOOGLE_TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';
const GOOGLE_REVOKE_TOKEN_URL =
  'https://accounts.google.com/o/oauth2/revoke?token=';

export type GetTokenCallback = (err: Error | null, token?: TokenData) => void;

export interface Credentials {
  privateKey: string;
  clientEmail?: string;
}

export interface TokenData {
  refresh_token?: string;
  expires_in?: number;
  access_token?: string;
  token_type?: string;
  id_token?: string;
}

export interface TokenOptions {
  keyFile?: string;
  key?: string;
  email?: string;
  iss?: string;
  sub?: string;
  scope?: string | string[];
  additionalClaims?: {};
  // Eagerly refresh unexpired tokens when they are within this many
  // milliseconds from expiring".
  // Defaults to 0
  eagerRefreshThresholdMillis?: number;
}

export interface GetTokenOptions {
  forceRefresh?: boolean;
}

class ErrorWithCode extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

let getPem: ((filename: string) => Promise<string>) | undefined;

export class GoogleToken {
  get accessToken() {
    return this.rawToken ? this.rawToken.access_token : undefined;
  }
  get idToken() {
    return this.rawToken ? this.rawToken.id_token : undefined;
  }
  get tokenType() {
    return this.rawToken ? this.rawToken.token_type : undefined;
  }
  get refreshToken() {
    return this.rawToken ? this.rawToken.refresh_token : undefined;
  }
  expiresAt?: number;
  key?: string;
  keyFile?: string;
  iss?: string;
  sub?: string;
  scope?: string;
  rawToken?: TokenData;
  tokenExpires?: number;
  email?: string;
  additionalClaims?: {};
  eagerRefreshThresholdMillis?: number;

  private inFlightRequest?: undefined | Promise<TokenData>;

  /**
   * Create a GoogleToken.
   *
   * @param options  Configuration object.
   */
  constructor(options?: TokenOptions) {
    this.configure(options);
  }

  /**
   * Returns whether the token has expired.
   *
   * @return true if the token has expired, false otherwise.
   */
  hasExpired() {
    const now = new Date().getTime();
    if (this.rawToken && this.expiresAt) {
      return now >= this.expiresAt;
    } else {
      return true;
    }
  }

  /**
   * Returns whether the token will expire within eagerRefreshThresholdMillis
   *
   * @return true if the token will be expired within eagerRefreshThresholdMillis, false otherwise.
   */
  isTokenExpiring() {
    const now = new Date().getTime();
    const eagerRefreshThresholdMillis = this.eagerRefreshThresholdMillis ?? 0;
    if (this.rawToken && this.expiresAt) {
      return this.expiresAt <= now + eagerRefreshThresholdMillis;
    } else {
      return true;
    }
  }

  /**
   * Returns a cached token or retrieves a new one from Google.
   *
   * @param callback The callback function.
   */
  getToken(opts?: GetTokenOptions): Promise<TokenData>;
  getToken(callback: GetTokenCallback, opts?: GetTokenOptions): void;
  getToken(
    callback?: GetTokenCallback | GetTokenOptions,
    opts = {} as GetTokenOptions
  ): void | Promise<TokenData> {
    if (typeof callback === 'object') {
      opts = callback as GetTokenOptions;
      callback = undefined;
    }
    opts = Object.assign(
      {
        forceRefresh: false,
      },
      opts
    );

    if (callback) {
      const cb = callback as GetTokenCallback;
      this.getTokenAsync(opts).then(t => cb(null, t), callback);
      return;
    }

    return this.getTokenAsync(opts);
  }

  /**
   * Given a keyFile, extract the key and client email if available
   * @param keyFile Path to a json, pem, or p12 file that contains the key.
   * @returns an object with privateKey and clientEmail properties
   */
  async getCredentials(keyFile: string): Promise<Credentials> {
    const ext = path.extname(keyFile);
    switch (ext) {
      case '.json': {
        const key = await readFile(keyFile, 'utf8');
        const body = JSON.parse(key);
        const privateKey = body.private_key;
        const clientEmail = body.client_email;
        if (!privateKey || !clientEmail) {
          throw new ErrorWithCode(
            'private_key and client_email are required.',
            'MISSING_CREDENTIALS'
          );
        }
        return {privateKey, clientEmail};
      }
      case '.der':
      case '.crt':
      case '.pem': {
        const privateKey = await readFile(keyFile, 'utf8');
        return {privateKey};
      }
      case '.p12':
      case '.pfx': {
        // NOTE:  The loading of `google-p12-pem` is deferred for performance
        // reasons.  The `node-forge` npm module in `google-p12-pem` adds a fair
        // bit time to overall module loading, and is likely not frequently
        // used.  In a future release, p12 support will be entirely removed.
        if (!getPem) {
          getPem = (await import('google-p12-pem')).getPem;
        }
        const privateKey = await getPem(keyFile);
        return {privateKey};
      }
      default:
        throw new ErrorWithCode(
          'Unknown certificate type. Type is determined based on file extension. ' +
            'Current supported extensions are *.json, *.pem, and *.p12.',
          'UNKNOWN_CERTIFICATE_TYPE'
        );
    }
  }

  private async getTokenAsync(opts: GetTokenOptions): Promise<TokenData> {
    if (this.inFlightRequest && !opts.forceRefresh) {
      return this.inFlightRequest;
    }

    try {
      return await (this.inFlightRequest = this.getTokenAsyncInner(opts));
    } finally {
      this.inFlightRequest = undefined;
    }
  }
  private async getTokenAsyncInner(opts: GetTokenOptions): Promise<TokenData> {
    if (this.isTokenExpiring() === false && opts.forceRefresh === false) {
      return Promise.resolve(this.rawToken!);
    }

    if (!this.key && !this.keyFile) {
      throw new Error('No key or keyFile set.');
    }

    if (!this.key && this.keyFile) {
      const creds = await this.getCredentials(this.keyFile);
      this.key = creds.privateKey;
      this.iss = creds.clientEmail || this.iss;
      if (!creds.clientEmail) {
        this.ensureEmail();
      }
    }
    return this.requestToken();
  }

  private ensureEmail() {
    if (!this.iss) {
      throw new ErrorWithCode('email is required.', 'MISSING_CREDENTIALS');
    }
  }

  /**
   * Revoke the token if one is set.
   *
   * @param callback The callback function.
   */
  revokeToken(): Promise<void>;
  revokeToken(callback: (err?: Error) => void): void;
  revokeToken(callback?: (err?: Error) => void): void | Promise<void> {
    if (callback) {
      this.revokeTokenAsync().then(() => callback(), callback);
      return;
    }
    return this.revokeTokenAsync();
  }

  private async revokeTokenAsync() {
    if (!this.accessToken) {
      throw new Error('No token to revoke.');
    }
    const url = GOOGLE_REVOKE_TOKEN_URL + this.accessToken;
    await request({url});
    this.configure({
      email: this.iss,
      sub: this.sub,
      key: this.key,
      keyFile: this.keyFile,
      scope: this.scope,
      additionalClaims: this.additionalClaims,
    });
  }

  /**
   * Configure the GoogleToken for re-use.
   * @param  {object} options Configuration object.
   */
  private configure(options: TokenOptions = {}) {
    this.keyFile = options.keyFile;
    this.key = options.key;
    this.rawToken = undefined;
    this.iss = options.email || options.iss;
    this.sub = options.sub;
    this.additionalClaims = options.additionalClaims;
    if (typeof options.scope === 'object') {
      this.scope = options.scope.join(' ');
    } else {
      this.scope = options.scope;
    }
    this.eagerRefreshThresholdMillis = options.eagerRefreshThresholdMillis;
  }

  /**
   * Request the token from Google.
   */
  private async requestToken(): Promise<TokenData> {
    const iat = Math.floor(new Date().getTime() / 1000);
    const additionalClaims = this.additionalClaims || {};
    const payload = Object.assign(
      {
        iss: this.iss,
        scope: this.scope,
        aud: GOOGLE_TOKEN_URL,
        exp: iat + 3600,
        iat,
        sub: this.sub,
      },
      additionalClaims
    );
    const signedJWT = jws.sign({
      header: {alg: 'RS256'},
      payload,
      secret: this.key,
    });
    try {
      const r = await request<TokenData>({
        method: 'POST',
        url: GOOGLE_TOKEN_URL,
        data: {
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signedJWT,
        },
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        responseType: 'json',
      });
      this.rawToken = r.data;
      this.expiresAt =
        r.data.expires_in === null || r.data.expires_in === undefined
          ? undefined
          : (iat + r.data.expires_in!) * 1000;
      return this.rawToken;
    } catch (e) {
      this.rawToken = undefined;
      this.tokenExpires = undefined;
      const body =
        (e as GaxiosError).response && (e as GaxiosError).response?.data
          ? (e as GaxiosError).response?.data
          : {};
      if (body.error) {
        const desc = body.error_description
          ? `: ${body.error_description}`
          : '';
        (e as GaxiosError).message = `${body.error}${desc}`;
      }
      throw e;
    }
  }
}
