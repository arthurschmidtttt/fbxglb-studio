# FBX to GLB Merge

Tools for turning a folder of animated `.fbx` files into a single `.glb` with embedded textures and selectable animation clips.

## What this project does

- Loads a folder of FBX files.
- Keeps textures embedded in the source files.
- Lets you preview and adjust the model in a browser-based 3D UI.
- Exports a final `.glb` with the selected animations.

## 3D software workflow

This project is designed to work with FBX files exported from 3D tools such as:

- AccuRIG
- Blender
- Mixamo-based pipelines

Typical workflow:

1. Prepare or rig the character in your 3D software.
2. Export the character and animations as FBX files.
3. Open the folder in `FBXGLB Studio`.
4. Review the mesh, rig, textures, and animation clips.
5. Export the final GLB for use in a game engine or viewer.

## Install

```bash
npm install
```

## Studio UI

Run the browser-based 3D editor:

```bash
npm run studio
```

In the studio, you can:

- Pick the FBX folder with the native folder picker.
- Preview the rig and mesh.
- Frame the model in the viewport.
- Select which animations are included in the final export.
- Rename animation clips before exporting.
- Review and tweak material tint, opacity, and texture assignment in GLB preview mode.

## Merge from folder

Generate a GLB directly from a folder of FBX files:

```bash
npm run merge -- "C:\path\to\fbx-folder"
```

By default, the output is written as `merged.glb` inside the same folder.

You can also pass a custom output path:

```bash
npm run merge -- "C:\path\to\fbx-folder" "C:\path\to\fbx-folder\output.glb"
```

## Preview mode

Preview mode opens the 3D workflow used to inspect the model before final export:

```bash
npm run preview -- "C:\path\to\fbx-folder"
```

## Fix Mixamo

If you need the Mixamo correction utility:

```bash
npm run fix -- "C:\path\to\model.fbx"
```

## Notes

- The FBX files should share the same skeleton structure and bone names for the final animation to make sense.
- The script preserves textures embedded in the FBX files and includes them in the `.glb`.
- Animations are exported separately using each file name.
- If your target engine loads the model facing the wrong way, rotate it in your 3D software or use the rig adjustment controls in the studio before exporting.
