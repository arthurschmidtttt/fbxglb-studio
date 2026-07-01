import bpy
import os
import sys
import tempfile
import json
import struct
import math
from pathlib import Path


def log(message):
    print(message, flush=True)


class PatchedTemporaryDirectory(tempfile.TemporaryDirectory):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def cleanup(self):
        return None


tempfile.TemporaryDirectory = PatchedTemporaryDirectory


PREVIEW_STATE = {}


def load_export_config():
    config_path = os.environ.get("FBX_GLB_CONFIG_PATH")
    if not config_path:
        return {}

    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def get_args():
    if "--" in sys.argv:
        argv = sys.argv[sys.argv.index("--") + 1 :]
    else:
        argv = []

    if not argv:
        raise SystemExit(
            'Usage: blender --background --python blender_merge.py -- "input_dir" ["output.glb"]'
        )

    input_dir = Path(argv[0]).resolve()
    output_path = Path(argv[1]).resolve() if len(argv) > 1 else input_dir / "merged.glb"
    return input_dir, output_path


def list_fbx_files(root_dir):
    files = [p for p in root_dir.rglob("*.fbx") if p.is_file()]
    files.sort(key=lambda p: str(p).lower())
    return files


def imported_delta(before_objects, before_actions):
    new_objects = [obj for obj in bpy.data.objects if obj.name not in before_objects]
    new_actions = [action for action in bpy.data.actions if action.name not in before_actions]
    return new_objects, new_actions


def remove_objects(objects):
    for obj in objects:
        try:
            bpy.data.objects.remove(obj, do_unlink=True)
        except RuntimeError:
            pass


def collect_referenced_images(objects):
    images = set()

    for obj in objects:
        for slot in getattr(obj, "material_slots", []):
            material = slot.material
            if not material or not material.use_nodes or not material.node_tree:
                continue

            for node in material.node_tree.nodes:
                if node.bl_idname == "ShaderNodeTexImage" and node.image:
                    images.add(node.image)

    return images


def linked_image_for_input(node_tree, node_name, input_name):
    node = node_tree.nodes.get(node_name)
    if not node:
        return None

    socket = node.inputs.get(input_name)
    if not socket or not socket.links:
        return None

    source = socket.links[0].from_node
    return source.image if getattr(source, "image", None) else None


def simplify_material(material, cache):
    if not material or not material.use_nodes or not material.node_tree:
        return material

    if material.name in cache:
        return cache[material.name]

    node_tree = material.node_tree
    base_image = linked_image_for_input(node_tree, "Principled BSDF", "Base Color")
    alpha_image = linked_image_for_input(node_tree, "Principled BSDF", "Alpha")

    normal_map_node = next((n for n in node_tree.nodes if n.bl_idname == "ShaderNodeNormalMap"), None)
    normal_image = None
    if normal_map_node and normal_map_node.inputs["Color"].links:
        source = normal_map_node.inputs["Color"].links[0].from_node
        normal_image = source.image if getattr(source, "image", None) else None

    if not base_image and not normal_image:
        cache[material.name] = material
        return material

    simple = bpy.data.materials.new(name=material.name)
    simple.use_nodes = True
    simple.blend_method = material.blend_method
    simple.alpha_threshold = getattr(material, "alpha_threshold", 0.5)
    simple.use_backface_culling = getattr(material, "use_backface_culling", False)

    nodes = simple.node_tree.nodes
    links = simple.node_tree.links
    for node in list(nodes):
        nodes.remove(node)

    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    output.location = (320, 0)
    principled.location = (40, 0)
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])

    if base_image:
        base_tex = nodes.new("ShaderNodeTexImage")
        base_tex.image = base_image
        base_tex.location = (-360, 120)
        if base_tex.image:
            base_tex.image.colorspace_settings.name = "sRGB"
        links.new(base_tex.outputs["Color"], principled.inputs["Base Color"])
        if alpha_image:
            links.new(base_tex.outputs["Alpha"], principled.inputs["Alpha"])
            principled.inputs["Alpha"].default_value = 1.0

    if normal_image:
        normal_tex = nodes.new("ShaderNodeTexImage")
        normal_tex.image = normal_image
        normal_tex.location = (-360, -180)
        if normal_tex.image:
            normal_tex.image.colorspace_settings.name = "Non-Color"
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (-120, -180)
        links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])

    cache[material.name] = simple
    return simple


def simplify_materials(objects):
    cache = {}

    for obj in objects:
        if obj.type != "MESH":
            continue

        for slot in getattr(obj, "material_slots", []):
            slot.material = simplify_material(slot.material, cache)


def find_armature(objects):
    for obj in objects:
        if obj.type == "ARMATURE":
            return obj
    return None


def normalize_name(value):
    return "".join(ch.lower() for ch in value if ch.isalnum())


def get_single_action(clip_name, armature, fallback_actions):
    normalized_clip_name = normalize_name(clip_name)

    if armature and armature.animation_data and armature.animation_data.action:
        active_action = armature.animation_data.action
        start, end = active_action.frame_range
        if end - start > 1.0 and normalized_clip_name in normalize_name(active_action.name):
            return active_action

    matching_actions = []
    fallback_valid_actions = []

    for action in fallback_actions:
        start, end = action.frame_range
        if end - start <= 1.0:
            continue

        fallback_valid_actions.append(action)
        if normalized_clip_name in normalize_name(action.name):
            matching_actions.append(action)

    if matching_actions:
        matching_actions.sort(key=lambda action: (action.frame_range[1] - action.frame_range[0]), reverse=True)
        return matching_actions[0]

    if armature and armature.animation_data and armature.animation_data.action:
        return armature.animation_data.action

    if fallback_valid_actions:
        fallback_valid_actions.sort(key=lambda action: (action.frame_range[1] - action.frame_range[0]), reverse=True)
        return fallback_valid_actions[0]

    if fallback_actions:
        return fallback_actions[0]

    return None


def create_action_tracks(armature, actions):
    armature.animation_data_create()
    armature.animation_data.action = None
    for track in list(armature.animation_data.nla_tracks):
        armature.animation_data.nla_tracks.remove(track)

    for action in actions:
        track = armature.animation_data.nla_tracks.new()
        track.name = action.name

        start, end = action.frame_range
        strip = track.strips.new(action.name, 0, action)
        strip.frame_start = 0
        strip.action_frame_start = start
        strip.action_frame_end = end
        strip.blend_type = "REPLACE"
        strip.extrapolation = "HOLD_FORWARD"


def apply_scale_to_objects(objects, active_object):
    if not objects:
        return

    bpy.ops.object.select_all(action="DESELECT")

    for obj in objects:
        obj.select_set(True)

    bpy.context.view_layer.objects.active = active_object
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def configure_temp_dirs(output_path):
    temp_root = (output_path.parent / ".blender-tmp").resolve()
    temp_root.mkdir(parents=True, exist_ok=True)

    os.environ["TMP"] = str(temp_root)
    os.environ["TEMP"] = str(temp_root)
    os.environ["TMPDIR"] = str(temp_root)
    tempfile.tempdir = str(temp_root)

    return temp_root


def apply_root_adjustments(base_armature, settings):
    if not base_armature or not settings:
        return

    location = settings.get("rootLocation")
    rotation_degrees = settings.get("rootRotationDegrees")

    if location and len(location) == 3:
        base_armature.location = (float(location[0]), float(location[1]), float(location[2]))

    if rotation_degrees and len(rotation_degrees) == 3:
        base_armature.rotation_mode = "XYZ"
        base_armature.rotation_euler = tuple(math.radians(float(value)) for value in rotation_degrees)


def strip_scale_animation_channels(glb_path):
    data = glb_path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise SystemExit(f"Not a GLB file: {glb_path}")

    json_chunk = None
    bin_chunks = []
    offset = 12

    while offset + 8 <= len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk_data = data[offset : offset + chunk_length]
        offset += chunk_length

        if chunk_type == 0x4E4F534A:
            json_chunk = chunk_data
        else:
            bin_chunks.append((chunk_type, chunk_data))

    if json_chunk is None:
        raise SystemExit(f"GLB JSON chunk not found: {glb_path}")

    gltf = json.loads(json_chunk.rstrip(b" \t\r\n\x00").decode("utf-8"))

    for animation in gltf.get("animations", []):
        samplers = animation.get("samplers", [])
        kept_samplers = []
        sampler_map = {}
        kept_channels = []

        for channel in animation.get("channels", []):
            if channel.get("target", {}).get("path") == "scale":
                continue

            old_sampler = channel.get("sampler")
            if old_sampler not in sampler_map:
                sampler_map[old_sampler] = len(kept_samplers)
                kept_samplers.append(samplers[old_sampler])

            kept_channel = dict(channel)
            kept_channel["sampler"] = sampler_map[old_sampler]
            kept_channels.append(kept_channel)

        animation["samplers"] = kept_samplers
        animation["channels"] = kept_channels

    json_bytes = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)

    total_length = 12 + 8 + len(json_bytes) + sum(8 + len(chunk) + ((-len(chunk)) % 4) for _, chunk in bin_chunks)
    rebuilt = bytearray()
    rebuilt.extend(data[:8])
    rebuilt.extend(struct.pack("<I", total_length))
    rebuilt.extend(struct.pack("<I", len(json_bytes)))
    rebuilt.extend(struct.pack("<I", 0x4E4F534A))
    rebuilt.extend(json_bytes)

    for chunk_type, chunk_data in bin_chunks:
        padded = chunk_data + b"\x00" * ((-len(chunk_data)) % 4)
        rebuilt.extend(struct.pack("<I", len(padded)))
        rebuilt.extend(struct.pack("<I", chunk_type))
        rebuilt.extend(padded)

    glb_path.write_bytes(bytes(rebuilt))


def prepare_scene(input_dir):
    fbx_files = list_fbx_files(input_dir)
    if not fbx_files:
        raise SystemExit(f"No FBX files found in: {input_dir}")

    base_armature = None
    collected_actions = []
    kept_objects = []

    for index, fbx_path in enumerate(fbx_files):
        log(f"[{index + 1}/{len(fbx_files)}] Importing {fbx_path.name}...")

        before_objects = {obj.name for obj in bpy.data.objects}
        before_actions = {action.name for action in bpy.data.actions}

        bpy.ops.import_scene.fbx(filepath=str(fbx_path), use_image_search=True)

        imported_objects, imported_actions = imported_delta(before_objects, before_actions)
        armature = find_armature(imported_objects)
        source_action = get_single_action(fbx_path.stem, armature, imported_actions)

        if index == 0:
            base_armature = armature
            kept_objects = imported_objects
            if not base_armature:
                raise SystemExit(f"No armature found in first FBX: {fbx_path}")
        else:
            if not armature:
                log(f"Warning: no armature found in {fbx_path.name}")

            # Keep actions, discard the imported temporary objects.
            remove_objects(imported_objects)

        if source_action:
            copied_action = source_action.copy()
            copied_action.name = fbx_path.stem
            collected_actions.append(copied_action)
        else:
            log(f"Warning: no action found in {fbx_path.name}")

    if not base_armature:
        raise SystemExit("No base armature found.")

    if not collected_actions:
        raise SystemExit("No actions collected from FBX files.")

    return {
        "base_armature": base_armature,
        "collected_actions": collected_actions,
        "kept_objects": kept_objects,
    }


def prepare_scene_for_export(state):
    simplify_materials(state["kept_objects"])

    used_images = collect_referenced_images(state["kept_objects"])
    for image in list(bpy.data.images):
        if image not in used_images:
            bpy.data.images.remove(image, do_unlink=True)

    create_action_tracks(state["base_armature"], state["collected_actions"])
    apply_scale_to_objects(state["kept_objects"], state["base_armature"])
    apply_root_adjustments(state["base_armature"], state.get("settings", {}))

    for obj in bpy.data.objects:
        obj.select_set(False)

    for obj in state["kept_objects"]:
        obj.select_set(True)

    bpy.context.view_layer.objects.active = state["base_armature"]


def export_scene(state, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_root = configure_temp_dirs(output_path)
    log(f"Temp dir: {temp_root}")

    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_nla_strips_merged_animation_name="MergedAnimation",
        export_force_sampling=True,
        export_frame_range=False,
        export_current_frame=False,
        export_yup=True,
        export_skins=True,
        export_normals=True,
        export_texcoords=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_keep_originals=False,
        export_unused_images=False,
        export_unused_textures=False,
        export_draco_mesh_compression_enable=False,
        export_all_influences=True,
        export_morph=False,
        export_extra_animations=True,
    )
    strip_scale_animation_channels(output_path)
    log(f"Exported: {output_path}")


class FBXGLB_OT_export_glb(bpy.types.Operator):
    bl_idname = "fbx_glb.export_glb"
    bl_label = "Export GLB"
    bl_options = {"REGISTER"}

    def execute(self, context):
        state = PREVIEW_STATE.get("state")
        output_path = PREVIEW_STATE.get("output_path")

        if not state or not output_path:
            self.report({"ERROR"}, "Preview state not ready.")
            return {"CANCELLED"}

        try:
            export_scene(state, output_path)
        except Exception as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        bpy.ops.wm.quit_blender()
        return {"FINISHED"}


class FBXGLB_OT_cancel_preview(bpy.types.Operator):
    bl_idname = "fbx_glb.cancel_preview"
    bl_label = "Cancel"

    def execute(self, context):
        bpy.ops.wm.quit_blender()
        return {"FINISHED"}


class FBXGLB_PT_preview_panel(bpy.types.Panel):
    bl_label = "FBX GLB Preview"
    bl_idname = "FBXGLB_PT_preview_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "FBX GLB"

    def draw(self, context):
        layout = self.layout
        state = PREVIEW_STATE.get("state")
        output_path = PREVIEW_STATE.get("output_path")

        layout.label(text="Ajuste o rig na viewport.")
        layout.label(text=f"Saida: {output_path}" if output_path else "Saida: indefinida")
        layout.operator("fbx_glb.export_glb", text="Seguir / Exportar")
        layout.operator("fbx_glb.cancel_preview", text="Cancelar")


def register_preview_ui(state, output_path):
    PREVIEW_STATE["state"] = state
    PREVIEW_STATE["output_path"] = output_path

    for cls in (FBXGLB_OT_export_glb, FBXGLB_OT_cancel_preview, FBXGLB_PT_preview_panel):
        try:
            bpy.utils.register_class(cls)
        except ValueError:
            pass


def main():
    input_dir, output_path = get_args()

    if not input_dir.is_dir():
        raise SystemExit(f"Input directory not found: {input_dir}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    state = prepare_scene(input_dir)
    state["settings"] = load_export_config().get("settings", {})
    prepare_scene_for_export(state)

    preview_mode = os.environ.get("FBX_GLB_PREVIEW") == "1"
    if preview_mode:
        register_preview_ui(state, output_path)
        log("Preview mode ready. Adjust the rig and click Export GLB.")
        return

    export_scene(state, output_path)


if __name__ == "__main__":
    main()
