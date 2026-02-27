/**
 * KINESYS — RobotArm Component
 *
 * Renders a 3-segment robotic arm (base + shoulder + elbow + gripper)
 * using Three.js meshes. Joint rotations are driven by the ArmController.
 *
 * Arm hierarchy:
 *   Base (Y-rotation) → Shoulder pivot (Z-rotation) → Segment 1 →
 *   Elbow pivot (Z-rotation) → Segment 2 → Wrist → Gripper (2 fingers)
 */

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import armController from "../engine/armController";

// ---------------------------------------------------------------------------
// Trajectory Trail
// ---------------------------------------------------------------------------

const TRAIL_LENGTH = 80; // Number of positions to keep in the ring buffer
const TRAIL_COLOR_HEAD = new THREE.Color("#a5b4fc"); // newest point
const TRAIL_COLOR_TAIL = new THREE.Color("#312e81"); // oldest point

/**
 * Renders a fading line showing the recent path of the end-effector.
 * Uses a fixed-size Float32Array ring buffer updated every frame.
 * Vertex colors fade from bright indigo (newest) to dark at the tail.
 */
function TrajectoryTrail() {
  // Allocate geometry + material once per mount
  const geoRef = useRef<THREE.BufferGeometry | null>(null);
  const lineObjRef = useRef<THREE.Line | null>(null);
  const ring = useRef<THREE.Vector3[]>([]);
  const tmpColor = useRef(new THREE.Color());

  if (!geoRef.current) {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(TRAIL_LENGTH * 3);
    const colors = new Float32Array(TRAIL_LENGTH * 3);
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, 0);
    geoRef.current = geo;

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      linewidth: 1,
      depthWrite: false,
    });
    lineObjRef.current = new THREE.Line(geo, mat);
  }

  useFrame(() => {
    const pos = armController.getEndEffectorPosition();

    ring.current.push(pos.clone());
    if (ring.current.length > TRAIL_LENGTH) {
      ring.current.shift();
    }

    const geo = geoRef.current!;
    const count = ring.current.length;
    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const colAttr = geo.attributes.color as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const p = ring.current[i]!;
      posArr[i * 3]     = p.x;
      posArr[i * 3 + 1] = p.y;
      posArr[i * 3 + 2] = p.z;

      const t = count > 1 ? i / (count - 1) : 1;
      tmpColor.current.lerpColors(TRAIL_COLOR_TAIL, TRAIL_COLOR_HEAD, t);
      colArr[i * 3]     = tmpColor.current.r;
      colArr[i * 3 + 1] = tmpColor.current.g;
      colArr[i * 3 + 2] = tmpColor.current.b;
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.setDrawRange(0, count);
  });

  return <primitive object={lineObjRef.current!} />;
}

// ---------------------------------------------------------------------------
// Dimensions (matching IK solver config)
// ---------------------------------------------------------------------------

const BASE_RADIUS = 0.18;
const BASE_HEIGHT = 0.5;
const SEGMENT_RADIUS = 0.06;
const SEGMENT1_LENGTH = 1.2;
const SEGMENT2_LENGTH = 1.0;
const JOINT_RADIUS = 0.09;
const GRIPPER_LENGTH = 0.15;
const GRIPPER_THICKNESS = 0.025;
const GRIPPER_MAX_OPEN = 0.08;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const baseMaterial = new THREE.MeshStandardMaterial({
  color: "#334155",
  metalness: 0.7,
  roughness: 0.3,
});

const segmentMaterial = new THREE.MeshStandardMaterial({
  color: "#6366f1",
  metalness: 0.5,
  roughness: 0.4,
});

const jointMaterial = new THREE.MeshStandardMaterial({
  color: "#475569",
  metalness: 0.8,
  roughness: 0.2,
});

const gripperMaterial = new THREE.MeshStandardMaterial({
  color: "#94a3b8",
  metalness: 0.6,
  roughness: 0.3,
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RobotArm() {
  const baseRef = useRef<THREE.Group>(null);
  const shoulderRef = useRef<THREE.Group>(null);
  const elbowRef = useRef<THREE.Group>(null);
  const gripperLeftRef = useRef<THREE.Mesh>(null);
  const gripperRightRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    armController.update(delta);
    const state = armController.getState();

    // Apply joint rotations
    if (baseRef.current) {
      baseRef.current.rotation.y = state.jointAngles[0];
    }
    if (shoulderRef.current) {
      shoulderRef.current.rotation.z = state.jointAngles[1];
    }
    if (elbowRef.current) {
      elbowRef.current.rotation.z = state.jointAngles[2];
    }

    // Animate gripper
    const halfOpen = (state.gripperOpenness * GRIPPER_MAX_OPEN) / 2;
    if (gripperLeftRef.current) {
      gripperLeftRef.current.position.x = -halfOpen - GRIPPER_THICKNESS / 2;
    }
    if (gripperRightRef.current) {
      gripperRightRef.current.position.x = halfOpen + GRIPPER_THICKNESS / 2;
    }
  });

  return (
    <>
      {/* Fading trajectory trail — rendered in world space */}
      <TrajectoryTrail />

      <group position={[0, 0.5, 0]}>
      {/* Base platform */}
      <mesh material={baseMaterial} position={[0, -BASE_HEIGHT / 2, 0]} castShadow>
        <cylinderGeometry args={[BASE_RADIUS, BASE_RADIUS * 1.3, BASE_HEIGHT, 32]} />
      </mesh>

      {/* Base rotation group */}
      <group ref={baseRef}>
        {/* Shoulder joint sphere */}
        <mesh material={jointMaterial} castShadow>
          <sphereGeometry args={[JOINT_RADIUS, 16, 16]} />
        </mesh>

        {/* Shoulder pivot group */}
        <group ref={shoulderRef}>
          {/* Segment 1 */}
          <mesh
            material={segmentMaterial}
            position={[0, SEGMENT1_LENGTH / 2, 0]}
            castShadow
          >
            <cylinderGeometry args={[SEGMENT_RADIUS, SEGMENT_RADIUS, SEGMENT1_LENGTH, 16]} />
          </mesh>

          {/* Elbow joint */}
          <group position={[0, SEGMENT1_LENGTH, 0]}>
            <mesh material={jointMaterial} castShadow>
              <sphereGeometry args={[JOINT_RADIUS * 0.85, 16, 16]} />
            </mesh>

            {/* Elbow pivot group */}
            <group ref={elbowRef}>
              {/* Segment 2 */}
              <mesh
                material={segmentMaterial}
                position={[0, SEGMENT2_LENGTH / 2, 0]}
                castShadow
              >
                <cylinderGeometry
                  args={[SEGMENT_RADIUS * 0.85, SEGMENT_RADIUS, SEGMENT2_LENGTH, 16]}
                />
              </mesh>

              {/* Wrist + Gripper */}
              <group position={[0, SEGMENT2_LENGTH, 0]}>
                {/* Wrist joint */}
                <mesh material={jointMaterial} castShadow>
                  <sphereGeometry args={[JOINT_RADIUS * 0.7, 16, 16]} />
                </mesh>

                {/* Gripper mount */}
                <mesh
                  material={gripperMaterial}
                  position={[0, GRIPPER_LENGTH * 0.3, 0]}
                  castShadow
                >
                  <boxGeometry args={[0.06, GRIPPER_LENGTH * 0.6, 0.06]} />
                </mesh>

                {/* Left finger */}
                <mesh
                  ref={gripperLeftRef}
                  material={gripperMaterial}
                  position={[-GRIPPER_MAX_OPEN / 2 - GRIPPER_THICKNESS / 2, GRIPPER_LENGTH * 0.8, 0]}
                  castShadow
                >
                  <boxGeometry args={[GRIPPER_THICKNESS, GRIPPER_LENGTH, 0.04]} />
                </mesh>

                {/* Right finger */}
                <mesh
                  ref={gripperRightRef}
                  material={gripperMaterial}
                  position={[GRIPPER_MAX_OPEN / 2 + GRIPPER_THICKNESS / 2, GRIPPER_LENGTH * 0.8, 0]}
                  castShadow
                >
                  <boxGeometry args={[GRIPPER_THICKNESS, GRIPPER_LENGTH, 0.04]} />
                </mesh>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
    </>
  );
}
