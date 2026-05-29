# OkHttp
-dontwarn okhttp3.**
-keep class okhttp3.** { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep @kotlinx.serialization.Serializable class com.clawd.mobile.** { *; }
-keep,includedescriptorclasses class com.clawd.mobile.**$$serializer { *; }
-keepclassmembers class com.clawd.mobile.** { *** Companion; }
-keepclasseswithmembers class com.clawd.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
