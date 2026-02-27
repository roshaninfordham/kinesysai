/**
 * KINESYS — SimulationCanvas Component
 *
 * Top-level 3D scene that composes:
 *   - Three.js renderer via @react-three/fiber
 *   - Cannon-es physics world via @react-three/cannon
 *   - Robotic arm with IK-driven joints
 *   - Physics-enabled scene objects on a table
 *   - PBR lighting, shadows, orbit camera controls
 *
 * Target: 60fps on a standard laptop GPU.
 */

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, ContactShadows, Grid } from "@react-three/drei";
import { Physics } from "@react-three/cannon";
import RobotArm from "./RobotArm";
import SceneObjects from "./SceneObjects";
import { GRAVITY } from "../engine/physics";

// ---------------------------------------------------------------------------
// Lighting rig
// ---------------------------------------------------------------------------

function Lighting() {
  return (
    <>
      {/* Ambient fill */}
      <ambientLight intensity={0.3} color="#cbd5e1" />

      {/* Key light — warm directional */}
      <directionalLight
        position={[5, 8, 3]}
        intensity={1.2}
        color="#fef3c7"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={20}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-bias={-0.0001}
      />

      {/* Fill light — cool blue from opposite side */}
      <directionalLight
        position={[-3, 4, -2]}
        intensity={0.4}
        color="#93c5fd"
      />

      {/* Rim light — subtle backlight */}
      <pointLight position={[0, 6, -4]} intensity={0.3} color="#c4b5fd" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading fallback
// ---------------------------------------------------------------------------

function LoadingIndicator() {
  return (
    <mesh position={[0, 1, 0]}>
      <sphereGeometry args={[0.1, 16, 16]} />
      <meshStandardMaterial color="#6366f1" emissive="#6366f1" emissiveIntensity={0.5} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Scene (inside Canvas)
// ---------------------------------------------------------------------------

function Scene() {
  return (
    <>
      <Lighting />

      {/* Environment map for reflections */}
      <Environment preset="city" />

      {/* Contact shadows under objects */}
      <ContactShadows
        position={[0, 0.01, 0]}
        opacity={0.4}
        scale={10}
        blur={2}
        far={4}
      />

      {/* Reference grid */}
      <Grid
        position={[0, 0.005, 0]}
        args={[10, 10]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#334155"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#475569"
        fadeDistance={8}
        infiniteGrid
      />

      {/* Physics world */}
      <Physics
        gravity={GRAVITY}
        defaultContactMaterial={{ friction: 0.5, restitution: 0.2 }}
        allowSleep
      >
        <SceneObjects />
      </Physics>

      {/* Robot arm (kinematic — not in physics world) */}
      <RobotArm />

      {/* Orbit camera controls */}
      <OrbitControls
        makeDefault
        enablePan
        enableZoom
        enableRotate
        minDistance={2}
        maxDistance={12}
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2 - 0.05}
        target={[0, 0.8, 0]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Canvas wrapper (exported)
// ---------------------------------------------------------------------------

export default function SimulationCanvas() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{
        position: [3, 3, 3],
        fov: 50,
        near: 0.1,
        far: 100,
      }}
      gl={{
        antialias: true,
        toneMapping: 3, // ACESFilmicToneMapping
        toneMappingExposure: 1.0,
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <Suspense fallback={<LoadingIndicator />}>
        <Scene />
      </Suspense>
    </Canvas>
  );
}
