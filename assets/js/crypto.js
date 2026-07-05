/* ============================================================================
 * KATE-KPI · Passphrase crypto (合言葉)
 * ----------------------------------------------------------------------------
 * Encrypts the linked-spreadsheet URLs with a shop passphrase so the CIPHERTEXT
 * can live in this public repository (data/shared-link.json) without exposing
 * the URLs — anyone can read the blob, but without the passphrase it is noise.
 * A new device enters the passphrase once, the URLs decrypt locally, and from
 * then on that device auto-loads the latest sheet data like any linked device.
 *
 * Primitives (Web Crypto API — browsers and Node 18+ both provide
 * globalThis.crypto.subtle):
 *   key  = PBKDF2(passphrase, salt, 310,000 iterations, SHA-256) → AES-256 key
 *   blob = AES-GCM(key, iv, plaintext JSON)
 * salt and iv are random per encryption and stored beside the ciphertext, so
 * the same passphrase re-encrypts to a different blob every time.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var subtle = global.crypto && global.crypto.subtle;
  var ITERATIONS = 310000;

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return (typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64'));
  }
  function b64ToBuf(b64) {
    var s = (typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'));
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }
  function deriveKey(passphrase, salt) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']).then(function (base) {
      return subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
    });
  }

  /** encrypt(passphrase, obj) → Promise<{v, salt, iv, ct}> (all base64, JSON-safe) */
  function encrypt(passphrase, obj) {
    if (!subtle) return Promise.reject(new Error('この環境では暗号化を利用できません（HTTPSでの表示が必要です）'));
    var salt = global.crypto.getRandomValues(new Uint8Array(16));
    var iv = global.crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(passphrase, salt).then(function (key) {
      var data = new TextEncoder().encode(JSON.stringify(obj));
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
    }).then(function (ct) {
      return { v: 1, salt: bufToB64(salt), iv: bufToB64(iv), ct: bufToB64(ct) };
    });
  }

  /** decrypt(passphrase, blob) → Promise<obj>. Rejects on wrong passphrase
   *  (AES-GCM authenticates — tampering or a bad key both fail cleanly). */
  function decrypt(passphrase, blob) {
    if (!subtle) return Promise.reject(new Error('この環境では復号を利用できません（HTTPSでの表示が必要です）'));
    if (!blob || blob.v !== 1 || !blob.salt || !blob.iv || !blob.ct) return Promise.reject(new Error('共有データの形式が不正です'));
    return deriveKey(passphrase, b64ToBuf(blob.salt)).then(function (key) {
      return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(blob.iv) }, key, b64ToBuf(blob.ct));
    }).then(function (buf) {
      return JSON.parse(new TextDecoder().decode(buf));
    }).catch(function () {
      throw new Error('合言葉が違います');
    });
  }

  global.KATE = global.KATE || {};
  global.KATE.crypto = { encrypt: encrypt, decrypt: decrypt };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KATE.crypto;
})(typeof window !== 'undefined' ? window : globalThis);
