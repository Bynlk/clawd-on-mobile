package com.clawd.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.clawd.mobile.overlay.SvgLoader

class ClawdApp : Application() {

    companion object {
        const val CHANNEL_APPROVAL = "clawd_approval"
        const val CHANNEL_STATUS = "clawd_status"
        const val CHANNEL_ALERT = "clawd_alert"
        const val CHANNEL_SERVICE = "clawd_service"
    }

    override fun onCreate() {
        super.onCreate()
        SvgLoader.init(this)
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)

            val approvalChannel = NotificationChannel(
                CHANNEL_APPROVAL,
                getString(R.string.channel_approval),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = getString(R.string.channel_approval_desc)
                enableVibration(true)
            }

            val statusChannel = NotificationChannel(
                CHANNEL_STATUS,
                getString(R.string.channel_status),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_status_desc)
                setShowBadge(false)
            }

            val alertChannel = NotificationChannel(
                CHANNEL_ALERT,
                getString(R.string.channel_alert),
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = getString(R.string.channel_alert_desc)
                enableVibration(true)
            }

            manager.createNotificationChannel(approvalChannel)
            manager.createNotificationChannel(statusChannel)
            manager.createNotificationChannel(alertChannel)

            val serviceChannel = NotificationChannel(
                CHANNEL_SERVICE,
                getString(R.string.channel_service),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_service_desc)
                setShowBadge(false)
            }
            manager.createNotificationChannel(serviceChannel)
        }
    }
}
