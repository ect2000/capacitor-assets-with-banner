/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mkdirp, pathExists, writeFile } from '@ionic/utils-fs';
import { dirname, join, relative } from 'path';
import type { OutputInfo, Sharp } from 'sharp';
import sharp from 'sharp';

import type { AssetGeneratorOptions } from '../../asset-generator';
import { AssetGenerator } from '../../asset-generator';
import type {
  AndroidOutputAssetTemplate,
  AndroidOutputAssetTemplateAdaptiveIcon,
  AndroidOutputAssetTemplateSplash,
  AndroidOutputAssetTemplateBanner,
} from '../../definitions';
import { AssetKind, Orientation, Platform } from '../../definitions';
import { BadPipelineError, BadProjectError } from '../../error';
import type { InputAsset } from '../../input-asset';
import { OutputAsset } from '../../output-asset';
import type { Project } from '../../project';
import { warn } from '../../util/log';

import * as AndroidAssetTemplates from './assets';

export class AndroidAssetGenerator extends AssetGenerator {
  constructor(options: AssetGeneratorOptions = {}) {
    super(options);
  }

  async generate(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const androidDir = project.config.android?.path;

    if (!androidDir) {
      throw new BadProjectError('No android project found');
    }

    if (asset.platform !== Platform.Any && asset.platform !== Platform.Android) {
      return [];
    }

    switch (asset.kind) {
      case AssetKind.Logo:
      case AssetKind.LogoDark:
        return this.generateFromLogo(asset, project);
      case AssetKind.Icon:
        return this.generateLegacyIcon(asset, project);
      case AssetKind.IconForeground:
        return this.generateAdaptiveIconForeground(asset, project);
      case AssetKind.IconBackground:
        return this.generateAdaptiveIconBackground(asset, project);
      case AssetKind.Banner:
        return this.generateBanners(asset, project);
      case AssetKind.Splash:
      case AssetKind.SplashDark:
        return this.generateSplashes(asset, project);
    }

    return [];
  }

  /**
   * Generate from logo combines all of the other operations into a single operation
   * from a single asset source file. In this mode, a logo along with a background color
   * is used to generate all icons and splash screens (with dark mode where possible).
   */
  private async generateFromLogo(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const pipe = asset.pipeline();
    const generated: OutputAsset[] = [];

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    // Generate adaptive icons
    const generatedAdaptiveIcons = await this._generateAdaptiveIconsFromLogo(project, asset, pipe);
    generated.push(...generatedAdaptiveIcons);

    if (asset.kind === AssetKind.Logo) {
      // Generate legacy icons
      const generatedLegacyIcons = await this.generateLegacyIcon(asset, project);
      generated.push(...generatedLegacyIcons);

      // Generate banners
      const banners = Object.values(AndroidAssetTemplates).filter((a) => a.kind === AssetKind.Banner);
      const generatedBanners = await Promise.all(
        banners.map(async (banner) => {
          return this._generateBannersFromLogo(
            project,
            asset,
            banner,
            pipe,
            this.options.splashBackgroundColor ?? '#ffffff',
          );
        }),
      );

      generated.push(...generatedBanners);

      // Generate splashes
      const splashes = Object.values(AndroidAssetTemplates).filter(
        (a): a is AndroidOutputAssetTemplateSplash => a.kind === AssetKind.Splash,
      );
      const generatedSplashes = await Promise.all(
        splashes.map(async (splash) => {
          return this._generateSplashesFromLogo(
            project,
            asset,
            splash,
            pipe,
            this.options.splashBackgroundColor ?? '#ffffff',
          );
        }),
      );

      generated.push(...generatedSplashes);
    }

    // Generate dark splashes
    const darkSplashes = Object.values(AndroidAssetTemplates).filter(
      (a): a is AndroidOutputAssetTemplateSplash => a.kind === AssetKind.SplashDark,
    );
    const generatedSplashes = await Promise.all(
      darkSplashes.map(async (splash) => {
        return this._generateSplashesFromLogo(
          project,
          asset,
          splash,
          pipe,
          this.options.splashBackgroundColorDark ?? '#111111',
        );
      }),
    );

    generated.push(...generatedSplashes);

    return [...generated];
  }

  // Generate adaptive icons from the source logo
  private async _generateAdaptiveIconsFromLogo(
    project: Project,
    asset: InputAsset,
    pipe: Sharp,
  ): Promise<OutputAsset[]> {
    // Current versions of Android don't appear to support night mode icons (13+ might?)
    // so, for now, we only generate light mode ones
    if (asset.kind === AssetKind.LogoDark) {
      return [];
    }

    // Create the background pipeline for the generated icons
    const backgroundPipe = sharp({
      create: {
        width: asset.width!,
        height: asset.height!,
        channels: 4,
        background:
          asset.kind === AssetKind.Logo
            ? this.options.iconBackgroundColor ?? '#ffffff'
            : this.options.iconBackgroundColorDark ?? '#111111',
      },
    });

    const icons = Object.values(AndroidAssetTemplates).filter(
      (a) => a.kind === AssetKind.AdaptiveIcon,
    ) as AndroidOutputAssetTemplateAdaptiveIcon[];

    const backgroundImages = await Promise.all(
      icons.map(async (icon) => {
        return await this._generateAdaptiveIconBackground(project, asset, icon, backgroundPipe);
      }),
    );

    const foregroundImages = await Promise.all(
      icons.map(async (icon) => {
        return await this._generateAdaptiveIconForeground(project, asset, icon, pipe);
      }),
    );

    return [...foregroundImages, ...backgroundImages];
  }

  private async _generateBannersFromLogo(
    project: Project,
    asset: InputAsset,
    splash: AndroidOutputAssetTemplate,
    pipe: Sharp,
    backgroundColor: string,
  ): Promise<OutputAsset> {
    // Generate light splash
    const resPath = this.getResPath(project);

    let drawableDir = `drawable`;
    if (splash.density) {
      drawableDir = `drawable-${splash.density}`;
    }

    const parentDir = join(resPath, drawableDir);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const dest = join(resPath, drawableDir, 'banner.png');

    const targetLogoWidthPercent = this.options.logoSplashScale ?? 0.2;
    let targetWidth = this.options.logoSplashTargetWidth ?? Math.floor((splash.width ?? 0) * targetLogoWidthPercent);

    if (targetWidth > splash.width || targetWidth > splash.height) {
      targetWidth = Math.floor((splash.width ?? 0) * targetLogoWidthPercent);
    }

    if (targetWidth > splash.width || targetWidth > splash.height) {
      warn(`Logo dimensions exceed dimensions of splash ${splash.width}x${splash.height}, using default logo size`);
      targetWidth = Math.floor((splash.width ?? 0) * 0.2);
    }

    const canvas = sharp({
      create: {
        width: splash.width ?? 0,
        height: splash.height ?? 0,
        channels: 4,
        background: backgroundColor,
      },
    });

    const resized = await sharp(asset.path).resize(targetWidth).toBuffer();

    const outputInfo = await canvas
      .composite([{ input: resized, gravity: sharp.gravity.center }])
      .png()
      .toFile(dest);

    const splashOutput = new OutputAsset(
      splash,
      asset,
      project,
      {
        [dest]: dest,
      },
      {
        [dest]: outputInfo,
      },
    );

    return splashOutput;
  }

  private async _generateSplashesFromLogo(
    project: Project,
    asset: InputAsset,
    splash: AndroidOutputAssetTemplateSplash,
    pipe: Sharp,
    backgroundColor: string,
  ): Promise<OutputAsset> {
    // Generate light splash
    const resPath = this.getResPath(project);

    // Build the qualifier array: land/port + density
    const quals: string[] = [];
    if (splash.orientation === Orientation.Landscape) {
      quals.push('land');
    } else if (splash.orientation === Orientation.Portrait) {
      quals.push('port');
    }
    if (splash.density && splash.orientation !== Orientation.Landscape && splash.orientation !== Orientation.Portrait) {
      quals.push(splash.density);
    }
    const drawableDir = quals.length > 0 ? `drawable-${quals.join('-')}` : 'drawable';

    const parentDir = join(resPath, drawableDir);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const dest = join(resPath, drawableDir, 'splash.png');

    const targetLogoWidthPercent = this.options.logoSplashScale ?? 0.2;
    let targetWidth = this.options.logoSplashTargetWidth ?? Math.floor((splash.width ?? 0) * targetLogoWidthPercent);

    if (targetWidth > splash.width || targetWidth > splash.height) {
      targetWidth = Math.floor((splash.width ?? 0) * targetLogoWidthPercent);
    }

    if (targetWidth > splash.width || targetWidth > splash.height) {
      warn(`Logo dimensions exceed dimensions of splash ${splash.width}x${splash.height}, using default logo size`);
      targetWidth = Math.floor((splash.width ?? 0) * 0.2);
    }

    const canvas = sharp({
      create: {
        width: splash.width ?? 0,
        height: splash.height ?? 0,
        channels: 4,
        background: backgroundColor,
      },
    });

    const resized = await sharp(asset.path).resize(targetWidth).toBuffer();

    const outputInfo = await canvas
      .composite([{ input: resized, gravity: sharp.gravity.center }])
      .png()
      .toFile(dest);

    const splashOutput = new OutputAsset(
      splash,
      asset,
      project,
      {
        [dest]: dest,
      },
      {
        [dest]: outputInfo,
      },
    );

    return splashOutput;
  }

  private async generateLegacyIcon(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const icons = Object.values(AndroidAssetTemplates).filter(
      (a) => a.kind === AssetKind.Icon,
    ) as AndroidOutputAssetTemplate[];

    const pipe = asset.pipeline();

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    const collected = await Promise.all(
      icons.map(async (icon) => {
        const [dest, outputInfo] = await this.generateLegacyLauncherIcon(project, asset, icon, pipe);

        return new OutputAsset(
          icon,
          asset,
          project,
          { [`mipmap-${icon.density}/ic_launcher.png`]: dest },
          { [`mipmap-${icon.density}/ic_launcher.png`]: outputInfo },
        );
      }),
    );

    collected.push(
      ...(await Promise.all(
        icons.map(async (icon) => {
          const [dest, outputInfo] = await this.generateRoundLauncherIcon(project, asset, icon, pipe);

          return new OutputAsset(
            icon,
            asset,
            project,
            { [`mipmap-${icon.density}/ic_launcher_round.png`]: dest },
            { [`mipmap-${icon.density}/ic_launcher_round.png`]: outputInfo },
          );
        }),
      )),
    );

    await this.updateManifest(project);

    return collected;
  }

  private async generateLegacyLauncherIcon(
    project: Project,
    asset: InputAsset,
    template: AndroidOutputAssetTemplate,
    pipe: Sharp,
  ): Promise<[string, OutputInfo]> {
    const radius = 4;
    const svg = `<svg width="${template.width}" height="${template.height}"><rect x="0" y="0" width="${template.width}" height="${template.height}" rx="${radius}" fill="#ffffff"/></svg>`;

    const resPath = this.getResPath(project);
    const parentDir = join(resPath, `mipmap-${template.density}`);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const destRound = join(resPath, `mipmap-${template.density}`, 'ic_launcher.png');

    // This pipeline is trick, but we need two separate pipelines
    // per https://github.com/lovell/sharp/issues/2378#issuecomment-864132578
    const padding = 8;
    const resized = await sharp(asset.path)
      .resize(template.width, template.height)
      // .composite([{ input: Buffer.from(svg), blend: 'dest-in' }])
      .toBuffer();
    const composited = await sharp(resized)
      .resize(Math.max(0, template.width - padding * 2), Math.max(0, template.height - padding * 2))
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
    const outputInfo = await sharp(composited).png().toFile(destRound);

    return [destRound, outputInfo];
  }

  private async generateRoundLauncherIcon(
    project: Project,
    asset: InputAsset,
    template: AndroidOutputAssetTemplate,
    pipe: Sharp,
  ): Promise<[string, OutputInfo]> {
    const svg = `<svg width="${template.width}" height="${template.height}"><circle cx="${template.width / 2}" cy="${
      template.height / 2
    }" r="${template.width / 2}" fill="#ffffff"/></svg>`;

    const resPath = this.getResPath(project);
    const destRound = join(resPath, `mipmap-${template.density}`, 'ic_launcher_round.png');

    // This pipeline is tricky, but we need two separate pipelines
    // per https://github.com/lovell/sharp/issues/2378#issuecomment-864132578
    const resized = await sharp(asset.path).resize(template.width, template.height).toBuffer();
    const composited = await sharp(resized)
      .composite([{ input: Buffer.from(svg), blend: 'dest-in' }])
      .toBuffer();
    const outputInfo = await sharp(composited).png().toFile(destRound);

    return [destRound, outputInfo];
  }

  private async generateAdaptiveIconForeground(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const icons = Object.values(AndroidAssetTemplates).filter(
      (a) => a.kind === AssetKind.Icon,
    ) as AndroidOutputAssetTemplateAdaptiveIcon[];

    const pipe = asset.pipeline();

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    return Promise.all(
      icons.map(async (icon) => {
        return await this._generateAdaptiveIconForeground(project, asset, icon, pipe);
      }),
    );
  }

  private async _generateAdaptiveIconForeground(
    project: Project,
    asset: InputAsset,
    icon: AndroidOutputAssetTemplateAdaptiveIcon,
    pipe: Sharp,
  ) {
    const resPath = this.getResPath(project);

    // Create the foreground and background images
    const destForeground = join(resPath, `mipmap-${icon.density}`, 'ic_launcher_foreground.png');
    const parentDir = dirname(destForeground);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const outputInfoForeground = await pipe.resize(icon.width, icon.height).png().toFile(destForeground);

    // Create the adaptive icon XML
    const icLauncherXml = `
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background>
        <inset android:drawable="@mipmap/ic_launcher_background" android:inset="16.7%" />
    </background>
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
</adaptive-icon>
    `.trim();

    const mipmapAnyPath = join(resPath, `mipmap-anydpi-v26`);
    if (!(await pathExists(mipmapAnyPath))) {
      await mkdirp(mipmapAnyPath);
    }
    const destIcLauncher = join(mipmapAnyPath, `ic_launcher.xml`);
    const destIcLauncherRound = join(mipmapAnyPath, `ic_launcher_round.xml`);
    await writeFile(destIcLauncher, icLauncherXml);
    await writeFile(destIcLauncherRound, icLauncherXml);

    // Return the created files for this OutputAsset
    return new OutputAsset(
      icon,
      asset,
      project,
      {
        [`mipmap-${icon.density}/ic_launcher_foreground.png`]: destForeground,
        'mipmap-anydpi-v26/ic_launcher.xml': destIcLauncher,
        'mipmap-anydpi-v26/ic_launcher_round.xml': destIcLauncherRound,
      },
      {
        [`mipmap-${icon.density}/ic_launcher_foreground.png`]: outputInfoForeground,
      },
    );
  }

  private async generateAdaptiveIconBackground(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const icons = Object.values(AndroidAssetTemplates).filter(
      (a) => a.kind === AssetKind.Icon,
    ) as AndroidOutputAssetTemplateAdaptiveIcon[];

    const pipe = asset.pipeline();

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    return Promise.all(
      icons.map(async (icon) => {
        return await this._generateAdaptiveIconBackground(project, asset, icon, pipe);
      }),
    );
  }
  private async _generateAdaptiveIconBackground(
    project: Project,
    asset: InputAsset,
    icon: AndroidOutputAssetTemplateAdaptiveIcon,
    pipe: Sharp,
  ) {
    const resPath = this.getResPath(project);

    const destBackground = join(resPath, `mipmap-${icon.density}`, 'ic_launcher_background.png');
    const parentDir = dirname(destBackground);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }

    const outputInfoBackground = await pipe.resize(icon.width, icon.height).png().toFile(destBackground);

    // Create the adaptive icon XML
    const icLauncherXml = `
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background>
        <inset android:drawable="@mipmap/ic_launcher_background" android:inset="16.7%" />
    </background>
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
</adaptive-icon>
    `.trim();

    const mipmapAnyPath = join(resPath, `mipmap-anydpi-v26`);
    if (!(await pathExists(mipmapAnyPath))) {
      await mkdirp(mipmapAnyPath);
    }
    const destIcLauncher = join(mipmapAnyPath, `ic_launcher.xml`);
    const destIcLauncherRound = join(mipmapAnyPath, `ic_launcher_round.xml`);
    await writeFile(destIcLauncher, icLauncherXml);
    await writeFile(destIcLauncherRound, icLauncherXml);

    // Return the created files for this OutputAsset
    return new OutputAsset(
      icon,
      asset,
      project,
      {
        [`mipmap-${icon.density}/ic_launcher_background.png`]: destBackground,
        'mipmap-anydpi-v26/ic_launcher.xml': destIcLauncher,
        'mipmap-anydpi-v26/ic_launcher_round.xml': destIcLauncherRound,
      },
      {
        [`mipmap-${icon.density}/ic_launcher_background.png`]: outputInfoBackground,
      },
    );
  }

  private async updateManifest(project: Project) {
    project.android?.getAndroidManifest()?.setAttrs('manifest/application', {
      'android:icon': '@mipmap/ic_launcher',
      'android:banner': '@drawable/banner',
      'android:roundIcon': '@mipmap/ic_launcher_round',
    });

    await project.commit();
  }

  private async generateBanners(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const pipe = asset.pipeline();

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    const banners = Object.values(AndroidAssetTemplates).filter(
      (a) => a.kind === AssetKind.Banner,
    ) as AndroidOutputAssetTemplateBanner[];

    const resPath = this.getResPath(project);

    const collected = await Promise.all(
      banners.map(async (banner) => {
        const [dest, outputInfo] = await this.generateBanner(project, asset, banner, pipe);

        const relPath = relative(resPath, dest);
        return new OutputAsset(banner, asset, project, { [relPath]: dest }, { [relPath]: outputInfo });
      }),
    );

    return collected;
  }

  private async generateBanner(
    project: Project,
    asset: InputAsset,
    template: AndroidOutputAssetTemplateBanner,
    pipe: Sharp,
  ): Promise<[string, OutputInfo]> {
    const drawableDir = template.density ? `drawable-${template.density}` : 'drawable';

    const resPath = this.getResPath(project);
    const parentDir = join(resPath, drawableDir);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const dest = join(resPath, drawableDir, 'banner.png');

    const outputInfo = await pipe.resize(template.width, template.height).png().toFile(dest);

    return [dest, outputInfo];
  }

  private async generateSplashes(asset: InputAsset, project: Project): Promise<OutputAsset[]> {
    const pipe = asset.pipeline();

    if (!pipe) {
      throw new BadPipelineError('Sharp instance not created');
    }

    const splashes = (
      asset.kind === AssetKind.Splash
        ? Object.values(AndroidAssetTemplates).filter((a) => a.kind === AssetKind.Splash)
        : Object.values(AndroidAssetTemplates).filter((a) => a.kind === AssetKind.SplashDark)
    ) as AndroidOutputAssetTemplateSplash[];

    const resPath = this.getResPath(project);

    const collected = await Promise.all(
      splashes.map(async (splash) => {
        const [dest, outputInfo] = await this.generateSplash(project, asset, splash, pipe);

        const relPath = relative(resPath, dest);
        return new OutputAsset(splash, asset, project, { [relPath]: dest }, { [relPath]: outputInfo });
      }),
    );

    return collected;
  }

  private async generateSplash(
    project: Project,
    asset: InputAsset,
    template: AndroidOutputAssetTemplateSplash,
    pipe: Sharp,
  ): Promise<[string, OutputInfo]> {
    // qualifiers from orientation and density
    const quals: string[] = [];
    if (template.orientation === Orientation.Landscape) {
      quals.push('land');
    } else if (template.orientation === Orientation.Portrait) {
      quals.push('port');
    }
    if (template.density) {
      quals.push(template.density);
    }
    console.log('quals', quals);

    const drawableDir = quals.length > 0 ? `drawable-${quals.join('-')}` : 'drawable';

    const resPath = this.getResPath(project);
    const parentDir = join(resPath, drawableDir);
    if (!(await pathExists(parentDir))) {
      await mkdirp(parentDir);
    }
    const dest = join(resPath, drawableDir, 'splash.png');

    const outputInfo = await pipe.resize(template.width, template.height).png().toFile(dest);

    console.log('Generated splash at:', dest);

    return [dest, outputInfo];
  }

  private getResPath(project: Project): string {
    return join(project.config.android!.path!, 'app', 'src', this.options.androidFlavor ?? 'main', 'res');
  }
}
