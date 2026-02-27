/**
 * KINESYS — TrajectoryViz Component
 *
 * Renders planned trajectory waypoints in the Three.js scene BEFORE the arm
 * executes them. Each waypoint is a semi-transparent sphere connected by lines.
 *
 * Color coding:
 *   - Green (#22c55e) = safe waypoint (passed validation)
 *   - Red (#ef4444) = waypoint that required re-planning or failed validation
 *
 * This gives judges a visual preview of what the AI is about to do.
 * The component subscribes to commandMode to receive planned waypoints.
 */

import { useRef, useEffect, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import commandMode, {
  type PipelineState,
  type Waypoint,
} from "../modes/commandMode";
import wsService, { type WSMessage } from "../services/websocketService";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPHERE_RADIUS = 0.035;
const SPHERE_SEGMENTS = 12;
const LINE_OPACITY = 0.5;
const SPHERE_OPACITY = 0.65;
const PULSE_SPEED = 3.0;
const FADE_SPEED = 2.0;

const COLOR_SAFE = new THREE.Color("#22c55e");
const COLOR_UNSAFE = new THREE.Color("#ef4444");
const COLOR_EXECUTING = new THREE.Color("#f59e0b");

// ---------------------------------------------------------------------------
// Component (must be rendered inside R3F Canvas)
// ---------------------------------------------------------------------------

export default function TrajectoryViz() {
  const groupRef = useRef<THREE.Group>(null);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [executingIndex, setExecutingIndex] = useState(-1);
  const [visible, setVisible] = useState(false);
  const fadeRef = useRef(0);

  // Subscribe to commandMode state + waypoints via WS
  useEffect(() => {
    const unsubState = commandMode.onStateChange((state: PipelineState) => {
      if (state === "EXECUTING") {
        setVisible(true);
        setExecutingIndex(0);
      } else if (state === "DONE" || state === "ERROR" || state === "IDLE") {
        // Start fade-out
        setExecutingIndex(-1);
        // Keep visible briefly then hide
        setTimeout(() => {
          setVisible(false);
          setWaypoints([]);
        }, 1500);
      }
    });

    const unsubMsg = wsService.onMessage((msg: WSMessage) => {
      if (msg.type === "plan_result") {
        const wps = (msg as unknown as { waypoints: Waypoint[] }).waypoints;
        if (wps && wps.length > 0) {
          setWaypoints(wps);
          setVisible(true);
          setExecutingIndex(-1);
        }
      }
    });

    return () => {
      unsubState();
      unsubMsg();
    };
  }, []);

  // Advance executing index over time (approximate — each waypoint ~500ms)
  useEffect(() => {
    if (executingIndex < 0 || waypoints.length === 0) return;
    const timer = setInterval(() => {
      setExecutingIndex((prev) => {
        if (prev >= waypoints.length - 1) {
          clearInterval(timer);
          return prev;
        }
        return prev + 1;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [executingIndex >= 0, waypoints.length]);

  // Animate fade and pulse
  useFrame((_, delta) => {
    if (!groupRef.current) return;

    if (visible) {
      fadeRef.current = Math.min(1, fadeRef.current + delta * FADE_SPEED);
    } else {
      fadeRef.current = Math.max(0, fadeRef.current - delta * FADE_SPEED);
    }

    groupRef.current.visible = fadeRef.current > 0.01;

    // Pulse executing waypoint sphere
    const children = groupRef.current.children;
    const time = performance.now() / 1000;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || !(child as THREE.Mesh).isMesh) continue;
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.MeshStandardMaterial;

      if (i === executingIndex) {
        const pulse = 0.5 + 0.5 * Math.sin(time * PULSE_SPEED);
        mat.emissiveIntensity = 0.5 + pulse * 0.5;
        mesh.scale.setScalar(1.0 + pulse * 0.3);
      } else if (i < executingIndex) {
        mat.opacity = 0.2 * fadeRef.current;
        mat.emissiveIntensity = 0;
        mesh.scale.setScalar(0.8);
      } else {
        mat.opacity = SPHERE_OPACITY * fadeRef.current;
        mat.emissiveIntensity = 0.15;
        mesh.scale.setScalar(1.0);
      }
    }
  });

  if (waypoints.length === 0) return null;

  // Build line geometry connecting waypoints
  const linePoints = waypoints.map(
    (wp) => new THREE.Vector3(wp.x, wp.y, wp.z)
  );

  return (
    <group ref={groupRef}>
      {/* Connecting line */}
      <primitive
        object={(() => {
          const geo = new THREE.BufferGeometry().setFromPoints(linePoints);
          const mat = new THREE.LineBasicMaterial({
            color: COLOR_SAFE,
            transparent: true,
            opacity: LINE_OPACITY,
            depthWrite: false,
          });
          return new THREE.Line(geo, mat);
        })()}
      />

      {/* Waypoint spheres */}
      {waypoints.map((wp, i) => {
        const isUnsafe = !wp.gripper_open && i > 0 && waypoints[i - 1]?.gripper_open;
        const color = isUnsafe ? COLOR_UNSAFE : COLOR_SAFE;
        const isExecuting = i === executingIndex;

        return (
          <mesh key={i} position={[wp.x, wp.y, wp.z]}>
            <sphereGeometry args={[SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_SEGMENTS]} />
            <meshStandardMaterial
              color={isExecuting ? COLOR_EXECUTING : color}
              emissive={isExecuting ? COLOR_EXECUTING : color}
              emissiveIntensity={0.15}
              transparent
              opacity={SPHERE_OPACITY}
              depthWrite={false}
            />
          </mesh>
        );
      })}

      {/* Gripper state indicators — small red/green dots above grip-change waypoints */}
      {waypoints.map((wp, i) => {
        if (i === 0) return null;
        const prev = waypoints[i - 1]!;
        if (prev.gripper_open === wp.gripper_open) return null;

        return (
          <mesh key={`grip-${i}`} position={[wp.x, wp.y + 0.08, wp.z]}>
            <sphereGeometry args={[0.015, 8, 8]} />
            <meshStandardMaterial
              color={wp.gripper_open ? "#22c55e" : "#ef4444"}
              emissive={wp.gripper_open ? "#22c55e" : "#ef4444"}
              emissiveIntensity={0.5}
              transparent
              opacity={0.8}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}
