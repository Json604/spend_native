package com.lym.spend.widget

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS-callable bridge: app pushes a fresh snapshot here whenever its state
 * changes. We persist to SharedPreferences and broadcast a widget refresh.
 */
class SpendWidgetBridgeModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SpendWidgetBridge"

    @ReactMethod
    fun updateSnapshot(snapshotJson: String, promise: Promise) {
        try {
            SpendWidgetStorage.writeSnapshotJson(reactApplicationContext, snapshotJson)
            SpendWidgetProvider.refreshAllWidgets(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("WIDGET_UPDATE_FAILED", e)
        }
    }
}
