package com.lym.spend.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Stores the complete auth session encrypted with a key held by Android Keystore. */
class SecureTokenStoreModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val preferences = reactContext.getSharedPreferences(PREFERENCES, 0)

  override fun getName(): String = MODULE_NAME

  @ReactMethod
  fun getSession(promise: Promise) {
    try {
      promise.resolve(preferences.getString(SESSION_KEY, null)?.let(::decrypt))
    } catch (error: Throwable) {
      promise.reject(ERROR, error.message, error)
    }
  }

  @ReactMethod
  fun setSession(access: String, refresh: String, userJson: String, promise: Promise) {
    try {
      val sessionJson = "{\"access\":${quote(access)},\"refresh\":${quote(refresh)},\"user\":$userJson}"
      // One encrypted preference write atomically rotates access and refresh.
      check(preferences.edit().putString(SESSION_KEY, encrypt(sessionJson)).commit()) {
        "Could not persist encrypted auth session"
      }
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject(ERROR, error.message, error)
    }
  }

  @ReactMethod
  fun clearSession(promise: Promise) {
    try {
      preferences.edit().remove(SESSION_KEY).commit()
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject(ERROR, error.message, error)
    }
  }

  @ReactMethod
  fun getDeviceId(promise: Promise) {
    try {
      val existing = preferences.getString(DEVICE_ID_KEY, null)?.let(::decrypt)
      if (existing != null) {
        promise.resolve(existing)
        return
      }
      val created = UUID.randomUUID().toString()
      check(preferences.edit().putString(DEVICE_ID_KEY, encrypt(created)).commit()) {
        "Could not persist encrypted device id"
      }
      promise.resolve(created)
    } catch (error: Throwable) {
      promise.reject(ERROR, error.message, error)
    }
  }

  private fun quote(value: String): String =
    org.json.JSONObject.quote(value)

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private fun encrypt(value: String): String {
    val iv = ByteArray(IV_SIZE).also(SecureRandom()::nextBytes)
    val cipher = Cipher.getInstance(TRANSFORMATION).apply {
      init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
    }
    return "${encode(iv)}:${encode(cipher.doFinal(value.toByteArray(Charsets.UTF_8)))}"
  }

  private fun decrypt(value: String): String {
    val parts = value.split(":", limit = 2)
    check(parts.size == 2) { "Malformed encrypted value" }
    val cipher = Cipher.getInstance(TRANSFORMATION).apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, decode(parts[0])))
    }
    return cipher.doFinal(decode(parts[1])).toString(Charsets.UTF_8)
  }

  private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.NO_WRAP)
  private fun decode(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

  companion object {
    const val MODULE_NAME = "SecureTokenStore"
    private const val PREFERENCES = "spend_secure_auth"
    private const val SESSION_KEY = "encrypted_session"
    private const val DEVICE_ID_KEY = "encrypted_device_id"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "spend_auth_aes_gcm_v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_SIZE = 12
    private const val TAG_BITS = 128
    private const val ERROR = "SECURE_STORAGE_ERROR"
  }
}
