"use strict";

/**
 * Stamp the Windows exe icon and version strings with resedit.
 *
 * electron-builder's default rcedit path downloads winCodeSign, whose
 * archive contains Darwin openssl dylibs as symlinks. Extracting those on
 * Windows without SeCreateSymbolicLinkPrivilege fails (7za exit 2) even
 * though the Windows tools themselves extracted. Code signing is out of
 * scope; this hook only replaces rcedit so `npm run dist` can finish.
 */
const fs = require("node:fs");
const path = require("node:path");
const ResEdit = require("resedit");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  // Isolation: skip PE rewrite if AFTERPACK_SKIP is set.
  if (process.env.AFTERPACK_SKIP === "1") {
    return;
  }

  const { appInfo, projectDir } = context.packager;
  const exeName = `${appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(projectDir, "build", "icon.ico");

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath));
  const res = ResEdit.NtExecutableResource.from(exe);

  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0] ? groups[0].id : 1;
  const groupLang = groups[0] ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    groupLang,
    iconFile.icons.map((item) => item.data)
  );

  const versionList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (versionList.length > 0) {
    const vi = versionList[0];
    const version = appInfo.version;
    vi.setFileVersion(version);
    vi.setProductVersion(version);
    const langs = vi.getAllLanguagesForStringValues();
    const lang = langs[0] || { lang: 1033, codepage: 1200 };
    vi.setStringValues(lang, {
      FileDescription: appInfo.description || appInfo.productName,
      ProductName: appInfo.productName,
      LegalCopyright: appInfo.copyright || "",
      OriginalFilename: exeName,
      InternalName: appInfo.productFilename,
      ProductVersion: version,
      FileVersion: version,
    });
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
