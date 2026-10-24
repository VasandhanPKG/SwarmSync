import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Eye, Compass, Crosshair, Layers, PlusCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { DeliveryTask, DroneState, SwarmSyncSimulator } from '../sim/engine';

interface DroneArena3DProps {
  simRef: React.MutableRefObject<SwarmSyncSimulator>;
  selectedDroneId: number;
  onSelectDrone: (id: number) => void;
  onSpawnTaskAt: (pickup: [number, number], dropoff: [number, number]) => void;
  renderTick: number;
}

type CameraMode = 'orbit' | 'chase' | 'topdown';

const WORLD_SCALE = 0.1; // 1000m sim arena -> 100 Three.js units (-50..+50)
const ALT_SCALE = 0.25;  // 30m sim altitude -> 7.5 Three.js units

function simToWorldX(simX: number): number {
  return (simX - 500) * WORLD_SCALE;
}

function simToWorldZ(simY: number): number {
  return (simY - 500) * WORLD_SCALE;
}

function worldToSimX(wx: number): number {
  return Math.max(50, Math.min(950, Math.round(wx / WORLD_SCALE + 500)));
}

function worldToSimY(wz: number): number {
  return Math.max(50, Math.min(950, Math.round(wz / WORLD_SCALE + 500)));
}

function makeSoftShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.52)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.2)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeTacticalGroundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#131d31';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle sub-grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }

  // Primary tile border
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 512, 512);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.anisotropy = 4;
  return tex;
}

function updateDroneLabelCanvas(
  canvas: HTMLCanvasElement,
  d: DroneState,
  isSelected: boolean
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Rounded badge background
  ctx.fillStyle = !d.alive
    ? 'rgba(127, 29, 29, 0.92)'
    : isSelected
    ? 'rgba(15, 23, 42, 0.95)'
    : 'rgba(15, 23, 42, 0.86)';
  ctx.strokeStyle = !d.alive
    ? '#f43f5e'
    : isSelected
    ? '#38bdf8'
    : 'rgba(148, 163, 184, 0.45)';
  ctx.lineWidth = isSelected ? 3 : 2;

  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 10);
  ctx.fill();
  ctx.stroke();

  // Header line: Autonomous Drone ID + Orders Dropped
  ctx.font = 'bold 20px "IBM Plex Mono", monospace';
  ctx.fillStyle = !d.alive ? '#fecdd3' : '#38bdf8';
  ctx.fillText(`D${d.id} [AUTONOMOUS]`, 16, 30);

  ctx.fillStyle = '#34d399';
  ctx.font = 'bold 18px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`DROPPED: ${d.ordersDropped}`, w - 16, 30);

  // Second line: Current independent decision / action
  ctx.textAlign = 'left';
  ctx.font = '600 16px "IBM Plex Mono", monospace';
  ctx.fillStyle = '#f8fafc';
  const summary =
    d.autonomousDecision.length > 36
      ? d.autonomousDecision.slice(0, 35) + '…'
      : d.autonomousDecision;
  ctx.fillText(summary, 16, 56);
}

interface DroneMeshRig {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  rotors: THREE.Mesh[];
  cargoBox: THREE.Mesh;
  visorMat: THREE.MeshStandardMaterial;
  canopyMat: THREE.MeshStandardMaterial;
  selectionRing: THREE.Mesh;
  groundShadow: THREE.Mesh;
  sectorPad: THREE.Mesh;
  trailLine: THREE.Line;
  trailPositions: Float32Array;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  labelSprite: THREE.Sprite;
  lastLabelKey: string;
}

interface TaskMeshRig {
  root: THREE.Group;
  pickupPad: THREE.Mesh;
  pickupCrate: THREE.Mesh;
  dropoffPad: THREE.Mesh;
  dropoffPadMat: THREE.MeshBasicMaterial;
  dropoffBeacon: THREE.Mesh;
  deliveredCrate: THREE.Group;
  routeLine: THREE.Line;
}

interface FallingDropRig {
  group: THREE.Group;
  crate: THREE.Mesh;
  chute: THREE.Mesh;
  impactRing: THREE.Mesh;
}

export const DroneArena3D: React.FC<DroneArena3DProps> = ({
  simRef,
  selectedDroneId,
  onSelectDrone,
  onSpawnTaskAt,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [showMeshLinks, setShowMeshLinks] = useState<boolean>(true);
  const [showTrails, setShowTrails] = useState<boolean>(true);
  const [spawnArmed, setSpawnArmed] = useState<boolean>(false);
  const [pendingPickup, setPendingPickup] = useState<[number, number] | null>(null);
  const [controlsCollapsed, setControlsCollapsed] = useState<boolean>(false);

  const selectedDroneIdRef = useRef<number>(selectedDroneId);
  selectedDroneIdRef.current = selectedDroneId;

  const cameraModeRef = useRef<CameraMode>(cameraMode);
  cameraModeRef.current = cameraMode;

  const showMeshLinksRef = useRef<boolean>(showMeshLinks);
  showMeshLinksRef.current = showMeshLinks;

  const showTrailsRef = useRef<boolean>(showTrails);
  showTrailsRef.current = showTrails;

  const spawnArmedRef = useRef<boolean>(spawnArmed);
  spawnArmedRef.current = spawnArmed;

  const pendingPickupRef = useRef<[number, number] | null>(pendingPickup);
  pendingPickupRef.current = pendingPickup;

  const callbacksRef = useRef({
    onSelectDrone,
    onSpawnTaskAt,
    setPendingPickup,
    setSpawnArmed,
  });
  callbacksRef.current = {
    onSelectDrone,
    onSpawnTaskAt,
    setPendingPickup,
    setSpawnArmed,
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 860;
    const height = container.clientHeight || 540;

    // Probe GPU renderer string to adapt automatically for software WebGL (SwiftShader/llvmpipe)
    const probeCanvas = document.createElement('canvas');
    const probeGl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
    const dbgInfo = probeGl?.getExtension('WEBGL_debug_renderer_info');
    const gpuRenderer = dbgInfo
      ? String(probeGl?.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) || '')
      : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpuRenderer);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const skyColor = 0x0f172a;
    scene.background = new THREE.Color(skyColor);
    scene.fog = new THREE.FogExp2(skyColor, 0.0022);

    // Environment map so metallic motor pods & glossy avionics domes have realistic reflections
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.5, 450);
    camera.position.set(0, 42, 62);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 12;
    controls.maxDistance = 165;
    controls.target.set(0, 4, 0);

    // Lighting: Hemisphere sky/ground fill + warm key sun + cool rim light
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.98);
    scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff4e0, 2.7);
    keyLight.position.set(55, 85, 45);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 10;
      keyLight.shadow.camera.far = 220;
      const d = 65;
      keyLight.shadow.camera.left = -d;
      keyLight.shadow.camera.right = d;
      keyLight.shadow.camera.top = d;
      keyLight.shadow.camera.bottom = -d;
      keyLight.shadow.bias = -0.0005;
    }
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.95);
    rimLight.position.set(-55, 40, -50);
    scene.add(rimLight);

    // Ground plane with procedural tactical grid texture
    const groundTex = makeTacticalGroundTexture();
    const groundGeo = new THREE.PlaneGeometry(260, 260);
    const groundMat = new THREE.MeshStandardMaterial({
      map: groundTex,
      roughness: 0.9,
      metalness: 0.06,
    });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = !isSoftwareGl;
    scene.add(groundMesh);

    // Active 1000m x 1000m operational boundary frame on ground (-50..+50)
    const borderPts = [
      new THREE.Vector3(-50, 0.06, -50),
      new THREE.Vector3(50, 0.06, -50),
      new THREE.Vector3(50, 0.06, 50),
      new THREE.Vector3(-50, 0.06, 50),
      new THREE.Vector3(-50, 0.06, -50),
    ];
    const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
    const borderLine = new THREE.Line(
      borderGeo,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45 })
    );
    scene.add(borderLine);

    // Natural perimeter ridge silhouettes so the ground plane never shows a raw edge
    const ridgeMat = new THREE.MeshStandardMaterial({
      color: 0x1b283d,
      roughness: 0.95,
      metalness: 0.04,
      flatShading: true,
    });
    const ridgeGroup = new THREE.Group();
    for (let i = 0; i < 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      const dist = 92 + (i % 3) * 11;
      const radius = 16 + (i % 4) * 5;
      const peakH = 12 + (i % 5) * 4.5;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius, peakH, 6), ridgeMat);
      cone.position.set(Math.cos(ang) * dist, peakH * 0.5 - 0.2, Math.sin(ang) * dist);
      cone.rotation.y = i * 0.7;
      ridgeGroup.add(cone);
    }
    scene.add(ridgeGroup);

    // Central Dispatch Hub (ONLY visible in 'centralized' baseline mode; hidden in decentralized modes!)
    const hubGroup = new THREE.Group();
    const hubPad = new THREE.Mesh(
      new THREE.CylinderGeometry(4.5, 5.0, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.82, metalness: 0.2 })
    );
    hubPad.position.y = 0.15;
    hubGroup.add(hubPad);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.36, 4.5, 12),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.28, metalness: 0.82 })
    );
    mast.position.y = 2.4;
    hubGroup.add(mast);

    const radarDish = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 0.45, 16, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.22,
        metalness: 0.85,
        side: THREE.DoubleSide,
      })
    );
    radarDish.position.y = 4.8;
    radarDish.rotation.x = Math.PI * 0.32;
    hubGroup.add(radarDish);

    const hubBeaconMat = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x10b981,
      emissiveIntensity: 1.4,
      roughness: 0.2,
    });
    const hubBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 12), hubBeaconMat);
    hubBeacon.position.y = 5.3;
    hubGroup.add(hubBeacon);
    hubGroup.visible = false;
    scene.add(hubGroup);

    // Network Partition 3D Barrier Wall across X = 0 (sim X = 500m)
    const partitionWall = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 18),
      new THREE.MeshBasicMaterial({
        color: 0xf43f5e,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    partitionWall.rotation.y = Math.PI / 2;
    partitionWall.position.set(0, 9, 0);
    partitionWall.visible = false;
    scene.add(partitionWall);

    // Peer-to-peer communication link lines (pre-allocated buffer)
    const maxLinks = 220;
    const linkPositions = new Float32Array(maxLinks * 6);
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPositions, 3));
    const linkLines = new THREE.LineSegments(
      linkGeo,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.38,
      })
    );
    scene.add(linkLines);

    // Pool of 3D in-flight message packet spheres
    const packetPool: THREE.Mesh[] = [];
    const packetGeo = new THREE.SphereGeometry(0.28, 10, 10);
    const packetMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(packetGeo, packetMat);
      m.visible = false;
      scene.add(m);
      packetPool.push(m);
    }

    // Pool of 3D Falling Order Crates (visualizes physical package drop from drone to pad!)
    const dropPool: FallingDropRig[] = [];
    const dropCrateGeo = new THREE.BoxGeometry(0.95, 0.72, 0.95);
    const dropCrateMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 0.35,
      roughness: 0.4,
      metalness: 0.2,
    });
    const dropChuteGeo = new THREE.ConeGeometry(0.95, 0.65, 10, 1, true);
    const dropChuteMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (let i = 0; i < 14; i++) {
      const group = new THREE.Group();
      const crate = new THREE.Mesh(dropCrateGeo, dropCrateMat);
      group.add(crate);

      const chute = new THREE.Mesh(dropChuteGeo, dropChuteMat);
      chute.position.y = 0.85;
      group.add(chute);

      const impactRing = new THREE.Mesh(
        new THREE.RingGeometry(0.8, 1.35, 24),
        new THREE.MeshBasicMaterial({
          color: 0x10b981,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        })
      );
      impactRing.rotation.x = -Math.PI / 2;
      impactRing.position.y = 0.08;
      scene.add(impactRing);

      group.visible = false;
      impactRing.visible = false;
      scene.add(group);
      dropPool.push({ group, crate, chute, impactRing });
    }

    // Shared materials/geometries for composite 3D Quadrotors
    const softShadowTex = makeSoftShadowTexture();
    const fuselageGeo = new THREE.BoxGeometry(1.5, 0.38, 0.96);
    const fuselageMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.72,
      metalness: 0.25,
    });
    const armGeo = new THREE.CylinderGeometry(0.065, 0.065, 3.2, 8);
    const armMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.65,
      metalness: 0.35,
    });
    const motorGeo = new THREE.CylinderGeometry(0.2, 0.17, 0.32, 12);
    const motorMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.22,
      metalness: 0.88,
    });
    const rotorGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.025, 16);
    const rotorMat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.44,
      depthWrite: false,
    });
    const skidGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.35, 8);
    const cargoGeo = new THREE.BoxGeometry(0.76, 0.56, 0.72);
    const cargoMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xb45309,
      emissiveIntensity: 0.25,
      roughness: 0.45,
      metalness: 0.18,
    });

    const droneRigs = new Map<number, DroneMeshRig>();
    const taskRigs = new Map<string, TaskMeshRig>();

    function createDroneRig(d: DroneState): DroneMeshRig {
      const droneId = d.id;
      const root = new THREE.Group();
      root.userData = { droneId };

      const bodyGroup = new THREE.Group();
      bodyGroup.scale.setScalar(1.38);
      bodyGroup.userData = { droneId };
      root.add(bodyGroup);

      // 1. Carbon-fiber fuselage
      const fuselage = new THREE.Mesh(fuselageGeo, fuselageMat);
      fuselage.castShadow = !isSoftwareGl;
      fuselage.userData = { droneId };
      bodyGroup.add(fuselage);

      // 2. Glossy aerodynamic avionics canopy
      const canopyMat = new THREE.MeshStandardMaterial({
        color: 0x0284c7,
        roughness: 0.16,
        metalness: 0.68,
      });
      const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.48, 16, 12), canopyMat);
      canopy.scale.set(1.32, 0.55, 0.88);
      canopy.position.set(0.05, 0.2, 0);
      canopy.userData = { droneId };
      bodyGroup.add(canopy);

      // 3. Nose LED orientation visor
      const visorMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x38bdf8,
        emissiveIntensity: 1.6,
        roughness: 0.2,
      });
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.58), visorMat);
      visor.position.set(0.74, 0.04, 0);
      visor.userData = { droneId };
      bodyGroup.add(visor);

      // 4 & 5. Crossed diagonal X-frame carbon arms
      const arm1 = new THREE.Mesh(armGeo, armMat);
      arm1.rotation.z = Math.PI / 2;
      arm1.rotation.y = Math.PI / 4;
      bodyGroup.add(arm1);

      const arm2 = new THREE.Mesh(armGeo, armMat);
      arm2.rotation.z = Math.PI / 2;
      arm2.rotation.y = -Math.PI / 4;
      bodyGroup.add(arm2);

      // 6-9. Four brushed-metal motor pods + 4 spinning rotor discs
      const rotors: THREE.Mesh[] = [];
      const offsets: [number, number][] = [
        [1.08, 1.08],
        [1.08, -1.08],
        [-1.08, 1.08],
        [-1.08, -1.08],
      ];
      for (const [ox, oz] of offsets) {
        const motor = new THREE.Mesh(motorGeo, motorMat);
        motor.position.set(ox, 0.12, oz);
        motor.userData = { droneId };
        bodyGroup.add(motor);

        const rotor = new THREE.Mesh(rotorGeo, rotorMat);
        rotor.position.set(ox, 0.3, oz);
        bodyGroup.add(rotor);
        rotors.push(rotor);
      }

      // 10. Dual tubular landing skids
      for (const sz of [-0.46, 0.46]) {
        const skid = new THREE.Mesh(skidGeo, armMat);
        skid.rotation.z = Math.PI / 2;
        skid.position.set(0, -0.36, sz);
        bodyGroup.add(skid);
      }

      // 11. Under-slung order crate (visible when carrying order to dropoff)
      const cargoBox = new THREE.Mesh(cargoGeo, cargoMat);
      cargoBox.position.set(0, -0.44, 0);
      cargoBox.visible = false;
      bodyGroup.add(cargoBox);

      // Selection ring around active drone
      const selectionRing = new THREE.Mesh(
        new THREE.RingGeometry(1.65, 1.98, 32),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        })
      );
      selectionRing.rotation.x = -Math.PI / 2;
      selectionRing.position.y = -0.15;
      bodyGroup.add(selectionRing);

      // Floating 3D Autonomous Decision & Order Drop Callout Sprite above drone
      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = 420;
      labelCanvas.height = 76;
      updateDroneLabelCanvas(labelCanvas, d, droneId === selectedDroneIdRef.current);
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      const labelMat = new THREE.SpriteMaterial({
        map: labelTexture,
        transparent: true,
        depthWrite: false,
      });
      const labelSprite = new THREE.Sprite(labelMat);
      labelSprite.position.set(0, 2.35, 0);
      labelSprite.scale.set(9.2, 1.68, 1);
      root.add(labelSprite);

      // Individual Decentralized Sector Pad on ground (each drone has its own autonomous pad!)
      const sectorPad = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.85, 6),
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.36,
          depthWrite: false,
        })
      );
      sectorPad.rotation.x = -Math.PI / 2;
      sectorPad.position.set(simToWorldX(d.homePos[0]), 0.04, simToWorldZ(d.homePos[1]));
      scene.add(sectorPad);

      // Soft ground contact shadow disc directly below the drone on y = 0.04
      const groundShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(3.8, 3.8),
        new THREE.MeshBasicMaterial({
          map: softShadowTex,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
        })
      );
      groundShadow.rotation.x = -Math.PI / 2;
      groundShadow.position.y = 0.04;
      scene.add(groundShadow);

      // 3D Flight trail line
      const maxTrailPts = 36;
      const trailPositions = new Float32Array(maxTrailPts * 3);
      const trailGeo = new THREE.BufferGeometry();
      trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
      const trailLine = new THREE.Line(
        trailGeo,
        new THREE.LineBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.55,
        })
      );
      scene.add(trailLine);
      scene.add(root);

      return {
        root,
        bodyGroup,
        rotors,
        cargoBox,
        visorMat,
        canopyMat,
        selectionRing,
        groundShadow,
        sectorPad,
        trailLine,
        trailPositions,
        labelCanvas,
        labelTexture,
        labelSprite,
        lastLabelKey: '',
      };
    }

    function createTaskRig(task: DeliveryTask): TaskMeshRig {
      const root = new THREE.Group();
      const px = simToWorldX(task.pickup[0]);
      const pz = simToWorldZ(task.pickup[1]);
      const dx = simToWorldX(task.dropoff[0]);
      const dz = simToWorldZ(task.dropoff[1]);

      // Ground route vector connecting Pickup -> Dropoff
      const routeGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(px, 0.07, pz),
        new THREE.Vector3(dx, 0.07, dz),
      ]);
      const routeLine = new THREE.Line(
        routeGeo,
        new THREE.LineBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.28,
        })
      );
      root.add(routeLine);

      // Pickup ground pad + waiting order box
      const pickupPad = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.5, 24),
        new THREE.MeshBasicMaterial({
          color: 0xf59e0b,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
        })
      );
      pickupPad.rotation.x = -Math.PI / 2;
      pickupPad.position.set(px, 0.05, pz);
      root.add(pickupPad);

      const pickupCrate = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.68, 0.9),
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.42, metalness: 0.2 })
      );
      pickupCrate.position.set(px, 0.35, pz);
      root.add(pickupCrate);

      // Dropoff ground pad + vertical translucent beacon
      const dropoffPadMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      });
      const dropoffPad = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.65, 24), dropoffPadMat);
      dropoffPad.rotation.x = -Math.PI / 2;
      dropoffPad.position.set(dx, 0.05, dz);
      root.add(dropoffPad);

      const dropoffBeacon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.45, 6.2, 14, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x10b981,
          transparent: true,
          opacity: 0.22,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      dropoffBeacon.position.set(dx, 3.1, dz);
      root.add(dropoffBeacon);

      // Delivered Order Package sitting on the dropoff pad once dropped by a drone!
      const deliveredCrate = new THREE.Group();
      const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.72, 0.95),
        new THREE.MeshStandardMaterial({
          color: 0x10b981,
          emissive: 0x059669,
          emissiveIntensity: 0.35,
          roughness: 0.38,
          metalness: 0.22,
        })
      );
      boxMesh.position.y = 0.36;
      deliveredCrate.add(boxMesh);

      const strapMesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 0.76, 0.22),
        new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.5 })
      );
      strapMesh.position.y = 0.36;
      deliveredCrate.add(strapMesh);

      deliveredCrate.position.set(dx, 0, dz);
      deliveredCrate.visible = false;
      root.add(deliveredCrate);

      scene.add(root);
      return {
        root,
        pickupPad,
        pickupCrate,
        dropoffPad,
        dropoffPadMat,
        dropoffBeacon,
        deliveredCrate,
        routeLine,
      };
    }

    // Raycasting for clicking drones or spawning tasks on ground
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moved > 6) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const droneRoots = Array.from(droneRigs.values()).map((r) => r.bodyGroup);
      const hits = raycaster.intersectObjects(droneRoots, true);
      if (hits.length > 0) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && obj.userData?.droneId === undefined) {
          obj = obj.parent;
        }
        if (obj?.userData?.droneId !== undefined) {
          callbacksRef.current.onSelectDrone(Number(obj.userData.droneId));
          return;
        }
      }

      if (spawnArmedRef.current || e.shiftKey) {
        const groundHits = raycaster.intersectObject(groundMesh, false);
        if (groundHits.length > 0) {
          const pt = groundHits[0].point;
          const sx = worldToSimX(pt.x);
          const sy = worldToSimY(pt.z);
          const curPickup = pendingPickupRef.current;
          if (!curPickup) {
            callbacksRef.current.setPendingPickup([sx, sy]);
          } else {
            callbacksRef.current.onSpawnTaskAt(curPickup, [sx, sy]);
            callbacksRef.current.setPendingPickup(null);
            callbacksRef.current.setSpawnArmed(false);
          }
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    ro.observe(container);

    // Software-WebGL fence-paced animation loop helper
    let disposed = false;
    let rafId = 0;
    let timerId = 0;
    const gl = renderer.getContext() as WebGL2RenderingContext;

    const afterDraw = (cb: () => void) => {
      if (disposed) return;
      if (!isSoftwareGl || typeof gl.fenceSync !== 'function') {
        rafId = requestAnimationFrame(cb);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        if (!sync) {
          timerId = window.setTimeout(cb, 80);
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.CONDITION_SATISFIED || status === gl.ALREADY_SIGNALED) {
          gl.deleteSync(sync);
          timerId = window.setTimeout(cb, 80);
        } else {
          timerId = window.setTimeout(poll, 5);
        }
      };
      timerId = window.setTimeout(poll, 5);
    };

    let lastTime = performance.now();

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const sim = simRef.current;

      // Central hub ONLY exists in 'centralized' baseline mode!
      hubGroup.visible = sim.mode === 'centralized';
      if (hubGroup.visible) {
        radarDish.rotation.y += dt * 1.4;
        const hubColor = sim.centralHubAlive ? 0x10b981 : 0xf43f5e;
        hubBeaconMat.color.setHex(hubColor);
        hubBeaconMat.emissive.setHex(hubColor);
      }

      partitionWall.visible = sim.partitionEnabled;

      // Sync drone rigs with sim.drones
      const presentDroneIds = new Set<number>();
      for (const d of sim.drones.values()) {
        presentDroneIds.add(d.id);
        let rig = droneRigs.get(d.id);
        if (!rig) {
          rig = createDroneRig(d);
          droneRigs.set(d.id, rig);
        }

        const wx = simToWorldX(d.position[0]);
        const wy = Math.max(0.32, d.altitude * ALT_SCALE);
        const wz = simToWorldZ(d.position[1]);

        rig.root.position.lerp(new THREE.Vector3(wx, wy, wz), 0.4);
        rig.sectorPad.visible = sim.mode !== 'centralized';

        // Attitude: yaw around Y, pitch & roll
        rig.bodyGroup.rotation.order = 'YXZ';
        rig.bodyGroup.rotation.y = -d.yaw;
        rig.bodyGroup.rotation.z = -d.pitch;
        rig.bodyGroup.rotation.x = d.roll;

        // Spin rotors when alive
        if (d.alive) {
          for (let i = 0; i < rig.rotors.length; i++) {
            rig.rotors[i].rotation.y += dt * 38 * (i % 2 === 0 ? 1 : -1);
          }
        }

        // Check if carrying picked-up cargo
        const activeTask = d.localState.currentTaskId
          ? d.localState.knownTasks.get(d.localState.currentTaskId)
          : null;
        rig.cargoBox.visible = Boolean(d.alive && activeTask && activeTask.picked_up);

        // Update canopy & nose visor colors by state
        if (!d.alive) {
          rig.canopyMat.color.setHex(0x991b1b);
          rig.visorMat.color.setHex(0xf43f5e);
          rig.visorMat.emissive.setHex(0xf43f5e);
        } else if (d.returningForSafety) {
          rig.canopyMat.color.setHex(0xd97706);
          rig.visorMat.color.setHex(0xf59e0b);
          rig.visorMat.emissive.setHex(0xf59e0b);
        } else if (activeTask && activeTask.picked_up) {
          rig.canopyMat.color.setHex(0x059669);
          rig.visorMat.color.setHex(0xf59e0b);
          rig.visorMat.emissive.setHex(0xf59e0b);
        } else if (activeTask) {
          rig.canopyMat.color.setHex(0x0284c7);
          rig.visorMat.color.setHex(0x10b981);
          rig.visorMat.emissive.setHex(0x10b981);
        } else {
          rig.canopyMat.color.setHex(0x0369a1);
          rig.visorMat.color.setHex(0x38bdf8);
          rig.visorMat.emissive.setHex(0x38bdf8);
        }

        const isSel = d.id === selectedDroneIdRef.current;
        rig.selectionRing.visible = isSel;

        // Update floating 3D autonomous decision badge if changed
        const labelKey = `${d.alive}-${isSel}-${d.ordersDropped}-${d.autonomousDecision}`;
        if (rig.lastLabelKey !== labelKey) {
          rig.lastLabelKey = labelKey;
          updateDroneLabelCanvas(rig.labelCanvas, d, isSel);
          rig.labelTexture.needsUpdate = true;
        }

        // Ground shadow directly beneath drone
        rig.groundShadow.position.set(rig.root.position.x, 0.04, rig.root.position.z);
        const shadowScale = Math.max(0.45, 1.15 - wy * 0.05);
        rig.groundShadow.scale.set(shadowScale, shadowScale, 1);

        // 3D Flight Trail
        rig.trailLine.visible = showTrailsRef.current && d.trail.length > 1;
        if (rig.trailLine.visible) {
          const pts = d.trail;
          const attr = rig.trailLine.geometry.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < 36; i++) {
            const src = pts[Math.min(i, pts.length - 1)];
            rig.trailPositions[i * 3] = simToWorldX(src[0]);
            rig.trailPositions[i * 3 + 1] = Math.max(0.3, src[1] * ALT_SCALE);
            rig.trailPositions[i * 3 + 2] = simToWorldZ(src[2]);
          }
          attr.needsUpdate = true;
          rig.trailLine.geometry.setDrawRange(0, pts.length);
        }
      }

      for (const [id, rig] of droneRigs.entries()) {
        if (!presentDroneIds.has(id)) {
          scene.remove(rig.root);
          scene.remove(rig.groundShadow);
          scene.remove(rig.sectorPad);
          scene.remove(rig.trailLine);
          droneRigs.delete(id);
        }
      }

      // Sync Delivery Task pads, beacons, and delivered packages sitting on dropoff pads
      const consolidated = sim.getConsolidatedTasks();
      const presentTaskIds = new Set<string>();
      for (const t of consolidated) {
        presentTaskIds.add(t.task_id);
        let trig = taskRigs.get(t.task_id);
        if (!trig) {
          trig = createTaskRig(t);
          taskRigs.set(t.task_id, trig);
        }
        const isDone = t.status === 'COMPLETED';
        trig.root.visible = true; // Keep completed dropoff pads & delivered orders visible in 3D!
        trig.pickupCrate.visible = !isDone && !t.picked_up;
        trig.pickupPad.visible = !isDone && !t.picked_up;
        trig.routeLine.visible = !isDone;
        trig.dropoffBeacon.visible = !isDone;

        if (!isDone) {
          trig.pickupCrate.rotation.y += dt * 1.1;
          trig.deliveredCrate.visible = false;
        } else {
          // Show delivered package resting on the 3D dropoff pad once drop completes
          const activeDrop = (sim.activeDrops || []).find((dr) => dr.taskId === t.task_id);
          const dropElapsed = activeDrop ? sim.currentTime - activeDrop.droppedAt : 99;
          trig.deliveredCrate.visible = dropElapsed >= 1.2;
        }
      }
      for (const [tid, trig] of taskRigs.entries()) {
        if (!presentTaskIds.has(tid)) {
          scene.remove(trig.root);
          taskRigs.delete(tid);
        }
      }

      // Animate 3D Falling Order Crates (physical order drop from drone to ground pad!)
      const activeDrops = sim.activeDrops || [];
      for (let i = 0; i < dropPool.length; i++) {
        const drRig = dropPool[i];
        if (i >= activeDrops.length) {
          drRig.group.visible = false;
          drRig.impactRing.visible = false;
          continue;
        }
        const ev = activeDrops[i];
        const age = Math.max(0, sim.currentTime - ev.droppedAt);
        const fallDuration = 1.4;
        const wx = simToWorldX(ev.dropoff[0]);
        const wz = simToWorldZ(ev.dropoff[1]);

        if (age <= fallDuration) {
          const frac = age / fallDuration;
          const startY = Math.max(3.2, ev.startAlt * ALT_SCALE);
          const curY = startY * (1 - frac) + 0.38 * frac;
          drRig.group.position.set(wx, curY, wz);
          drRig.crate.rotation.y = age * 2.5;
          drRig.chute.visible = frac < 0.92;
          drRig.group.visible = true;
        } else {
          drRig.group.visible = false;
        }

        // Expanding emerald pulse ring on the ground dropoff pad
        drRig.impactRing.position.set(wx, 0.08, wz);
        const pulseScale = 1 + (age % 1.5) * 1.8;
        drRig.impactRing.scale.set(pulseScale, pulseScale, 1);
        drRig.impactRing.visible = true;
      }

      // Update 3D Peer-to-Peer Mesh Links
      linkLines.visible = showMeshLinksRef.current;
      if (showMeshLinksRef.current) {
        const dronesArr = Array.from(sim.drones.values()).filter((d) => d.alive);
        let linkIdx = 0;
        for (let i = 0; i < dronesArr.length; i++) {
          for (let j = i + 1; j < dronesArr.length; j++) {
            const a = dronesArr[i];
            const b = dronesArr[j];
            if (sim.canCommunicate(a.id, b.id) && linkIdx < maxLinks) {
              const rigA = droneRigs.get(a.id);
              const rigB = droneRigs.get(b.id);
              if (rigA && rigB) {
                const base = linkIdx * 6;
                linkPositions[base] = rigA.root.position.x;
                linkPositions[base + 1] = rigA.root.position.y;
                linkPositions[base + 2] = rigA.root.position.z;
                linkPositions[base + 3] = rigB.root.position.x;
                linkPositions[base + 4] = rigB.root.position.y;
                linkPositions[base + 5] = rigB.root.position.z;
                linkIdx++;
              }
            }
          }
        }
        (linkGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        linkGeo.setDrawRange(0, linkIdx * 2);
      }

      // Update 3D in-flight forum packets
      const inFlight = sim.inFlightPackets || [];
      for (let i = 0; i < packetPool.length; i++) {
        const pktMesh = packetPool[i];
        if (!showMeshLinksRef.current || i >= inFlight.length) {
          pktMesh.visible = false;
          continue;
        }
        const env = inFlight[i];
        const rigS = droneRigs.get(env.fromId);
        const rigR = droneRigs.get(env.toId);
        if (!rigS || !rigR) {
          pktMesh.visible = false;
          continue;
        }
        const duration = Math.max(0.05, env.deliverAt - env.sentAt);
        const frac = Math.min(1, Math.max(0, (sim.currentTime - env.sentAt) / duration));
        pktMesh.position.lerpVectors(rigS.root.position, rigR.root.position, frac);
        pktMesh.visible = true;
      }

      // Camera Mode behavior
      const cMode = cameraModeRef.current;
      const selRig = droneRigs.get(selectedDroneIdRef.current);
      if (cMode === 'chase' && selRig) {
        const targetPos = selRig.root.position.clone();
        const desiredCam = new THREE.Vector3(targetPos.x - 14, targetPos.y + 9.5, targetPos.z + 16);
        camera.position.lerp(desiredCam, 0.08);
        controls.target.lerp(targetPos, 0.15);
      } else if (cMode === 'topdown') {
        const desiredCam = new THREE.Vector3(0, 118, 0.01);
        camera.position.lerp(desiredCam, 0.08);
        controls.target.lerp(new THREE.Vector3(0, 0, 0), 0.12);
      }

      controls.update();
      renderer.render(scene, camera);
      afterDraw(tick);
    };

    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      envRT.dispose();
      renderer.dispose();
    };
  }, [simRef]);

  const sim = simRef.current;
  const selectedDrone = sim.drones.get(selectedDroneId);
  const totalOrdersDropped = Array.from(sim.drones.values()).reduce(
    (acc, d) => acc + d.ordersDropped,
    0
  );

  return (
    <section className="relative bg-slate-900 border border-slate-800 rounded-lg overflow-hidden shadow-sm">
      {/* Top 3D Status Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-200">
        <div className="flex items-center gap-3 font-mono">
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
            ● {sim.mode === 'centralized' ? 'CENTRALIZED BASELINE 3D' : 'DECENTRALIZED P2P SWARM (NO CENTRAL HUB)'}
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-amber-300 font-semibold">
            ORDERS DROPPED: {totalOrdersDropped}
          </span>
          {selectedDrone && (
            <>
              <span className="text-slate-600">|</span>
              <span className="text-sky-300">
                D{selectedDrone.id}: {selectedDrone.autonomousDecision}
              </span>
            </>
          )}
          {spawnArmed && (
            <span className="text-amber-400 font-semibold">
              {pendingPickup
                ? `Click 3D ground for DROPOFF (Pickup at ${pendingPickup[0]}m, ${pendingPickup[1]}m)`
                : 'Click 3D ground for PICKUP location'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
          <span>Drag: Orbit</span>
          <span>·</span>
          <span>Scroll: Zoom</span>
          <span>·</span>
          <span>Click Drone: Inspect</span>
        </div>
      </div>

      {/* Dedicated Three.js Canvas Mount Container */}
      <div
        ref={mountRef}
        className="w-full h-[540px] cursor-grab active:cursor-grabbing relative"
        aria-label="3D Autonomous Drone Swarm Simulation Canvas"
      />

      {/* Consolidated Collapsible Bottom Control Dock (Single-Row Compact Bar) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center max-w-[96%]">
        {!controlsCollapsed ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-900/95 border border-slate-700 rounded-lg shadow-lg text-[11px] text-slate-100 overflow-x-auto max-w-full">
            {/* Camera Presets */}
            <button
              type="button"
              onClick={() => setCameraMode('orbit')}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                cameraMode === 'orbit'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Compass className="w-3 h-3" />
              Orbit
            </button>
            <button
              type="button"
              onClick={() => setCameraMode('chase')}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                cameraMode === 'chase'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Crosshair className="w-3 h-3" />
              Chase D{selectedDroneId}
            </button>
            <button
              type="button"
              onClick={() => setCameraMode('topdown')}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                cameraMode === 'topdown'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Eye className="w-3 h-3" />
              Top-Down
            </button>

            <span className="h-3.5 w-px bg-slate-700 mx-0.5 shrink-0" />

            {/* 3D Telemetry Layer Toggles */}
            <button
              type="button"
              onClick={() => setShowMeshLinks((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                showMeshLinks
                  ? 'bg-slate-800 text-sky-300 border border-sky-500/40'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              <Layers className="w-3 h-3" />
              P2P Links
            </button>

            <button
              type="button"
              onClick={() => setShowTrails((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                showTrails
                  ? 'bg-slate-800 text-sky-300 border border-sky-500/40'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              Trails
            </button>

            <button
              type="button"
              onClick={() => {
                setSpawnArmed((v) => !v);
                setPendingPickup(null);
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded font-medium transition-colors whitespace-nowrap shrink-0 ${
                spawnArmed
                  ? 'bg-amber-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <PlusCircle className="w-3 h-3" />
              {spawnArmed ? 'Cancel Click' : 'Place Task'}
            </button>

            <span className="h-3.5 w-px bg-slate-700 mx-0.5 shrink-0" />

            <button
              type="button"
              onClick={() => setControlsCollapsed(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <ChevronDown className="w-3 h-3" />
              Hide
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setControlsCollapsed(false)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg shadow-lg text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <ChevronUp className="w-3.5 h-3.5 text-sky-400" />
            Show 3D Controls
          </button>
        )}
      </div>
    </section>
  );
};
