/**
 * KINESYS — Scene Objects Component
 *
 * Renders the table surface and physics-enabled manipulable objects.
 * Each object has a Cannon-es rigid body for realistic physics.
 */

import * as THREE from "three";
import { useBox, useSphere, useCylinder, usePlane } from "@react-three/cannon";
import { TABLE, DEFAULT_SCENE_OBJECTS, type SceneObjectDef } from "../engine/physics";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function Table() {
  const [tableRef] = useBox<THREE.Mesh>(() => ({
    type: "Static",
    position: TABLE.position,
    args: TABLE.size,
    material: { friction: 0.6, restitution: 0.1 },
  }));

  return (
    <group>
      {/* Table top */}
      <mesh ref={tableRef} receiveShadow castShadow>
        <boxGeometry args={TABLE.size} />
        <meshStandardMaterial
          color={TABLE.color}
          metalness={0.1}
          roughness={0.8}
        />
      </mesh>

      {/* Table legs */}
      {[
        [-TABLE.size[0] / 2 + 0.08, 0, -TABLE.size[2] / 2 + 0.08],
        [TABLE.size[0] / 2 - 0.08, 0, -TABLE.size[2] / 2 + 0.08],
        [-TABLE.size[0] / 2 + 0.08, 0, TABLE.size[2] / 2 - 0.08],
        [TABLE.size[0] / 2 - 0.08, 0, TABLE.size[2] / 2 - 0.08],
      ].map((pos, i) => (
        <mesh
          key={i}
          position={pos as [number, number, number]}
          castShadow
        >
          <cylinderGeometry args={[0.04, 0.04, TABLE.size[1], 8]} />
          <meshStandardMaterial
            color={TABLE.legColor}
            metalness={0.3}
            roughness={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Ground Plane
// ---------------------------------------------------------------------------

function Ground() {
  const [ref] = usePlane<THREE.Mesh>(() => ({
    type: "Static",
    rotation: [-Math.PI / 2, 0, 0],
    position: [0, 0, 0],
    material: { friction: 0.5, restitution: 0.1 },
  }));

  return (
    <mesh ref={ref} receiveShadow>
      <planeGeometry args={[20, 20]} />
      <meshStandardMaterial color="#1e293b" metalness={0.0} roughness={1.0} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Physics-enabled scene objects
// ---------------------------------------------------------------------------

function PhysicsBox({ def }: { def: SceneObjectDef }) {
  const args = def.size as [number, number, number];
  const [ref] = useBox<THREE.Mesh>(() => ({
    mass: def.mass,
    position: def.position,
    args,
    material: { friction: 0.4, restitution: 0.3 },
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow name={def.id}>
      <boxGeometry args={args} />
      <meshStandardMaterial color={def.color} metalness={0.2} roughness={0.6} />
    </mesh>
  );
}

function PhysicsSphere({ def }: { def: SceneObjectDef }) {
  const radius = def.size[0]!;
  const [ref] = useSphere<THREE.Mesh>(() => ({
    mass: def.mass,
    position: def.position,
    args: [radius],
    material: { friction: 0.4, restitution: 0.3 },
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow name={def.id}>
      <sphereGeometry args={[radius, 32, 32]} />
      <meshStandardMaterial color={def.color} metalness={0.2} roughness={0.5} />
    </mesh>
  );
}

function PhysicsCylinder({ def }: { def: SceneObjectDef }) {
  const radius = def.size[0]!;
  const height = def.size[1]!;
  const [ref] = useCylinder<THREE.Mesh>(() => ({
    mass: def.mass,
    position: def.position,
    args: [radius, radius, height, 16],
    material: { friction: 0.4, restitution: 0.3 },
  }));

  return (
    <mesh ref={ref} castShadow receiveShadow name={def.id}>
      <cylinderGeometry args={[radius, radius, height, 32]} />
      <meshStandardMaterial color={def.color} metalness={0.2} roughness={0.5} />
    </mesh>
  );
}

function SceneObject({ def }: { def: SceneObjectDef }) {
  switch (def.shape) {
    case "box":
      return <PhysicsBox def={def} />;
    case "sphere":
      return <PhysicsSphere def={def} />;
    case "cylinder":
      return <PhysicsCylinder def={def} />;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default function SceneObjects() {
  return (
    <group>
      <Ground />
      <Table />
      {DEFAULT_SCENE_OBJECTS.map((def) => (
        <SceneObject key={def.id} def={def} />
      ))}
    </group>
  );
}
