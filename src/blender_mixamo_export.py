import bpy
import os
import sys
import tempfile
from pathlib import Path
from mathutils import Matrix


class PatchedTemporaryDirectory(tempfile.TemporaryDirectory):
    def cleanup(self):
        return None


tempfile.TemporaryDirectory = PatchedTemporaryDirectory


def log(message):
    print(message, flush=True)


def get_args():
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1 :]
    else:
        argv = []

    if len(argv) < 2:
        raise SystemExit(
            'Usage: blender --background --python blender_mixamo_export.py -- "input.fbx" "output.fbx"'
        )

    input_path = Path(argv[0]).resolve()
    output_path = Path(argv[1]).resolve()
    return input_path, output_path


def configure_temp_dirs(output_path):
    temp_root = (output_path.parent / ".blender-tmp").resolve()
    temp_root.mkdir(parents=True, exist_ok=True)

    os.environ["TMP"] = str(temp_root)
    os.environ["TEMP"] = str(temp_root)
    os.environ["TMPDIR"] = str(temp_root)
    tempfile.tempdir = str(temp_root)

    return temp_root


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_fbx(input_path):
    before_names = {obj.name for obj in bpy.data.objects}
    bpy.ops.import_scene.fbx(filepath=str(input_path), use_image_search=True, use_anim=False)
    imported = [obj for obj in bpy.data.objects if obj.name not in before_names]
    return imported


def prepare_armature_for_bind_pose(imported):
    armature = next((obj for obj in imported if obj.type == "ARMATURE"), None)
    if not armature:
        return

    if getattr(armature.data, "pose_position", None) is not None:
      armature.data.pose_position = "REST"

    if armature.animation_data:
        armature.animation_data.action = None
        for track in list(armature.animation_data.nla_tracks):
            armature.animation_data.nla_tracks.remove(track)


def bake_mesh_objects(imported):
    prepare_armature_for_bind_pose(imported)

    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked_objects = []

    for obj in imported:
        if obj.type != "MESH":
            continue

        evaluated = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(
            evaluated,
            preserve_all_data_layers=True,
            depsgraph=depsgraph
        )
        mesh.transform(obj.matrix_world)

        baked = bpy.data.objects.new(obj.name, mesh)
        baked.matrix_world = Matrix.Identity(4)
        bpy.context.scene.collection.objects.link(baked)

        if obj.material_slots:
            for slot in obj.material_slots:
                baked.data.materials.append(slot.material)

        baked_objects.append(baked)

    return baked_objects


def apply_selection(imported):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        if obj.type != "MESH":
            continue
        obj.select_set(True)
    active = next((obj for obj in imported if obj.type == "MESH"), None)
    if active is None and imported:
        active = imported[0]
    if active is not None:
        bpy.context.view_layer.objects.active = active


def export_fbx(output_path, imported):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mesh_objects = bake_mesh_objects(imported)
    if not mesh_objects:
        raise SystemExit("No mesh objects were imported from the FBX.")

    apply_selection(mesh_objects)
    bpy.ops.export_scene.fbx(
        filepath=str(output_path),
        use_selection=True,
        object_types={"MESH"},
        use_mesh_modifiers=True,
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=True,
        mesh_smooth_type="FACE",
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="-Z",
        axis_up="Y",
    )


def main():
    input_path, output_path = get_args()
    if not input_path.exists():
        raise SystemExit(f"Input FBX not found: {input_path}")

    if output_path.name.lower() != "z-avatar-mixamo.fbx":
        output_path = output_path.with_name("z-avatar-mixamo.fbx")

    temp_root = configure_temp_dirs(output_path)
    log(f"Temp dir: {temp_root}")
    clear_scene()
    imported = import_fbx(input_path)
    if not imported:
        raise SystemExit("No objects were imported from the FBX.")

    export_fbx(output_path, imported)
    log(f"Exported Mixamo FBX: {output_path}")


if __name__ == "__main__":
    main()
