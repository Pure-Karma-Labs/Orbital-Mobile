// HAND-EDITED. Listed in ubrn.config.yaml's `noOverwrite`, so
// `ubrn build android --and-generate` will NOT rewrite it.
//
// ubrn's template registers only its own `OrbitalArchiveReaderModule` (the
// Rust/JSI installer). This package ships a SECOND, hand-written TurboModule —
// `OrbitalArchiveAccessModule`, which owns the document picker, SAF
// persistable permissions, file descriptors and staging-file creation — and
// both have to be reachable from one autolinked Gradle project, because both
// halves of one feature must ship in one pod and one AAR.
//
// If you add a third module here, add it in BOTH places below: `getModule`
// decides what can be constructed, and `getReactModuleInfoProvider` decides
// what React Native believes exists. A module present in only one of them
// fails at runtime as "module not found" with nothing in the build log.
package com.orbital.archivereader

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.util.HashMap

class OrbitalArchiveReaderPackage : TurboReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return when (name) {
      OrbitalArchiveReaderModule.NAME -> OrbitalArchiveReaderModule(reactContext)
      OrbitalArchiveAccessModule.NAME -> OrbitalArchiveAccessModule(reactContext)
      else -> null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
      moduleInfos[OrbitalArchiveReaderModule.NAME] = ReactModuleInfo(
        OrbitalArchiveReaderModule.NAME,
        OrbitalArchiveReaderModule.NAME,
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        true // isTurboModule
      )
      moduleInfos[OrbitalArchiveAccessModule.NAME] = ReactModuleInfo(
        OrbitalArchiveAccessModule.NAME,
        OrbitalArchiveAccessModule.NAME,
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        true // isTurboModule
      )
      moduleInfos
    }
  }
}
