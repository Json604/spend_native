package com.lym.spend

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.lym.spend.db.SpendCoordinator
import com.lym.spend.notification.SpendNotificationManager
import java.util.concurrent.Executors

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    super.onCreate(null)
    requestNotificationPermissionDuringOnboarding()
    rereadCategorisationDeepLink(intent)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    if (intent == null) return
    setIntent(intent)
    rereadCategorisationDeepLink(intent)
  }

  private fun requestNotificationPermissionDuringOnboarding() {
    if (Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ||
      SpendNotificationManager.permissionPrompted(this)
    ) return

    // This is the first-run/onboarding entry point. Remember that the prompt
    // was shown so a denial does not nag on every launch.
    SpendNotificationManager.markPermissionPrompted(this)
    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
  }

  private fun rereadCategorisationDeepLink(intent: Intent) {
    val data = intent.data ?: return
    if (data.scheme != "spend" || data.host != "categorise") return
    val transactionId = data.pathSegments.firstOrNull()?.takeIf(String::isNotBlank) ?: return

    // More… carries only the transaction id. Re-read the row now so a stale
    // notification cannot dictate the category or display deleted state.
    deepLinkExecutor.execute {
      val current = try {
        SpendCoordinator.getInstance(applicationContext).query(
          "SELECT id FROM transactions WHERE id = ? AND deleted_at IS NULL",
          arrayOf(Uri.decode(transactionId)),
        ).firstOrNull()
      } catch (_: Throwable) {
        null
      }
      if (current != null) intent.putExtra(EXTRA_CURRENT_TRANSACTION_ID, current["id"].toString())
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Spend"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  companion object {
    private const val NOTIFICATION_PERMISSION_REQUEST = 7001
    private const val EXTRA_CURRENT_TRANSACTION_ID = "spend_current_transaction_id"
    private val deepLinkExecutor = Executors.newSingleThreadExecutor()
  }
}
