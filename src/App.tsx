import React, { useEffect, useRef, useState } from 'react';
import Matter from 'matter-js';

// --- Utils & Constants ---
const NOISE_SCALE_1 = 300;
const NOISE_AMP_1 = 150;
const NOISE_SCALE_2 = 800;
const NOISE_AMP_2 = 250;

function getTerrainY(x: number) {
  return Math.sin(x / NOISE_SCALE_1) * NOISE_AMP_1 + Math.sin(x / NOISE_SCALE_2) * NOISE_AMP_2 + 400;
}

function GlitchText({ text, active = false }: { text: string; active?: boolean }) {
  return (
    <span className={`relative inline-block font-mono font-bold tracking-widest uppercase ${active ? 'glitch-flash' : ''}`}>
      <span className="absolute top-0 left-[-3px] text-[#FF00FF] mix-blend-screen tearing select-none" aria-hidden="true">{text}</span>
      <span className="absolute top-0 left-[3px] text-[#00FFFF] mix-blend-screen tearing select-none" style={{ animationDelay: '0.1s' }} aria-hidden="true">{text}</span>
      <span className="relative z-10 text-white">{text}</span>
    </span>
  );
}

// --- Game Logic Hooks & Rendering ---
type GameMode = 'classic' | 'time_trial' | 'low_gravity';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeMode, setActiveMode] = useState<GameMode | null>(null);
  const [gameState, setGameState] = useState<'menu' | 'running' | 'gameover'>('menu');
  
  // HUD State (Using refs to avoid re-renders during loop, we'll sync specific elements directly or occasionally)
  const statsRef = useRef({ distance: 0, fuel: 100, time: 60, speed: 0 });
  const hudRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (gameState !== 'running' || !activeMode || !canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set real resolution based on CSS size
    canvas.width = containerRef.current.clientWidth;
    canvas.height = window.innerHeight * 0.7; // ~70vh

    const engine = Matter.Engine.create();
    // Setup Gravity based on mode
    engine.gravity.y = activeMode === 'low_gravity' ? 0.3 : 1;

    // --- Vehicle Assembly ---
    const group = Matter.Body.nextGroup(true);
    const startX = 0;
    const startY = getTerrainY(startX) - 150;

    const chassis = Matter.Bodies.rectangle(startX, startY, 120, 30, { 
      collisionFilter: { group }, 
      density: 0.002,
      label: 'chassis' 
    });
    const wheelA = Matter.Bodies.circle(startX - 45, startY + 20, 22, { 
      collisionFilter: { group }, 
      friction: 1.0, 
      density: 0.005,
      restitution: 0.1,
      label: 'wheel' 
    });
    const wheelB = Matter.Bodies.circle(startX + 45, startY + 20, 22, { 
      collisionFilter: { group }, 
      friction: 1.0, 
      density: 0.005,
      restitution: 0.1,
      label: 'wheel' 
    });

    const axelA = Matter.Constraint.create({
      bodyA: chassis, pointA: { x: -45, y: 15 },
      bodyB: wheelA,
      stiffness: 0.3, length: 25, damping: 0.2
    });
    const axelB = Matter.Constraint.create({
      bodyA: chassis, pointA: { x: 45, y: 15 },
      bodyB: wheelB,
      stiffness: 0.3, length: 25, damping: 0.2
    });

    const car = Matter.Composite.create();
    Matter.Composite.add(car, [chassis, wheelA, wheelB, axelA, axelB]);
    Matter.World.add(engine.world, car);

    // --- Procedural Terrain Manager ---
    let currentGenX = -800; // Start a bit behind
    const activeTerrainBodies: Matter.Body[] = [];
    const collectableBodies: Matter.Body[] = [];

    const generateTerrainChunk = (targetX: number) => {
      const segWidth = 60;
      const newBodies = [];
      const newCollectables = [];
      
      while (currentGenX < targetX) {
        const nextX = currentGenX + segWidth;
        const y1 = getTerrainY(currentGenX);
        const y2 = getTerrainY(nextX);
        
        const cx = (currentGenX + nextX) / 2;
        const cy = (y1 + y2) / 2;
        const angle = Math.atan2(y2 - y1, nextX - currentGenX);
        const length = Math.sqrt(segWidth*segWidth + (y2-y1)*(y2-y1));
        
        // Use a deeply extending rectangle so it forms solid ground
        const rect = Matter.Bodies.rectangle(cx, cy + 300, length + 2, 600, {
          isStatic: true, angle: angle, friction: 0.9, label: 'terrain'
        });
        newBodies.push(rect);

        // Random hazards/items
        if (Math.random() < 0.08) {
           const type = activeMode === 'time_trial' ? 'time' : 'fuel';
           // Place above ground
           const item = Matter.Bodies.rectangle(cx, cy - 80, 40, 40, {
             isStatic: true, isSensor: true, label: type
           });
           newCollectables.push(item);
        }
        
        currentGenX = nextX;
      }
      Matter.World.add(engine.world, [...newBodies, ...newCollectables]);
      activeTerrainBodies.push(...newBodies);
      collectableBodies.push(...newCollectables);

      // Cleanup old terrain far behind
      while(activeTerrainBodies.length > 0 && activeTerrainBodies[0].position.x < chassis.position.x - 1500) {
        const old = activeTerrainBodies.shift();
        if(old) Matter.World.remove(engine.world, old);
      }
      // Cleanup items
      for(let i = collectableBodies.length - 1; i >= 0; i--) {
        if(collectableBodies[i].position.x < chassis.position.x - 1500) {
           Matter.World.remove(engine.world, collectableBodies[i]);
           collectableBodies.splice(i, 1);
        }
      }
    };

    // Initial terrain
    generateTerrainChunk(startX + 2000);

    // --- Input & Control ---
    const keys: { [key: string]: boolean } = {};
    const handleKeyDown = (e: KeyboardEvent) => { keys[e.code] = true; };
    const handleKeyUp = (e: KeyboardEvent) => { keys[e.code] = false; };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // --- Collision & Collectables ---
    Matter.Events.on(engine, 'collisionStart', (event) => {
      event.pairs.forEach((pair) => {
        const { bodyA, bodyB } = pair;
        const checkCollect = (item: Matter.Body, other: Matter.Body) => {
           if (other.label === 'chassis' || other.label === 'wheel') {
             if (item.label === 'fuel') {
                statsRef.current.fuel = Math.min(100, statsRef.current.fuel + 40);
                Matter.World.remove(engine.world, item);
                item.label = 'collected'; // avoid double triggers
             } else if (item.label === 'time') {
                statsRef.current.time += 15;
                Matter.World.remove(engine.world, item);
                item.label = 'collected';
             }
           }
        };
        if (bodyA.isSensor) checkCollect(bodyA, bodyB);
        if (bodyB.isSensor) checkCollect(bodyB, bodyA);
      });
    });

    // --- Main Game Loop ---
    let animFrame: number;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const dt = time - lastTime;
      lastTime = time;

      // Ensure terrain is always generated ahead
      if (currentGenX < chassis.position.x + 2000) {
         generateTerrainChunk(chassis.position.x + 2000);
      }

      // Input Application (Torque)
      const torqueAmt = 0.4;
      if (keys['ArrowRight'] || keys['KeyD']) {
         Matter.Body.setAngularVelocity(wheelA, wheelA.angularVelocity + torqueAmt * 0.1);
         Matter.Body.setAngularVelocity(wheelB, wheelB.angularVelocity + torqueAmt * 0.1);
      }
      if (keys['ArrowLeft'] || keys['KeyA']) {
         Matter.Body.setAngularVelocity(wheelA, wheelA.angularVelocity - torqueAmt * 0.1);
         Matter.Body.setAngularVelocity(wheelB, wheelB.angularVelocity - torqueAmt * 0.1);
      }

      // Air Control
      if (keys['ArrowLeft'] || keys['KeyA']) Matter.Body.setAngularVelocity(chassis, chassis.angularVelocity - 0.01);
      if (keys['ArrowRight'] || keys['KeyD']) Matter.Body.setAngularVelocity(chassis, chassis.angularVelocity + 0.01);

      Matter.Engine.update(engine, 1000 / 60);

      // Game State Mgmt
      statsRef.current.distance = Math.max(0, Math.floor(chassis.position.x / 50));
      statsRef.current.speed = Math.floor(Math.abs(chassis.velocity.x * 10));
      
      if (activeMode !== 'time_trial') {
         statsRef.current.fuel -= dt * 0.005; // Depletion rate
         if (statsRef.current.fuel <= 0) {
            setGameState('gameover');
            return;
         }
      } else {
         statsRef.current.time -= dt / 1000;
         if (statsRef.current.time <= 0) {
            setGameState('gameover');
            return;
         }
      }

      // Update HUD manually for perf
      if (hudRef.current) {
         hudRef.current.innerHTML = `
           <div class="flex flex-col gap-2">
              <div>DIST: <span class="text-[#00FFFF]">${statsRef.current.distance}m</span></div>
              <div>SPD: <span class="text-[#00FFFF]">${statsRef.current.speed}km/h</span></div>
              ${activeMode === 'time_trial' 
                ? `<div>T-MINUS: <span class="text-[#FF00FF]">${statsRef.current.time.toFixed(1)}s</span></div>`
                : `<div class="mt-2 w-48 h-4 border-2 border-[#FF00FF] relative"><div class="h-full bg-[#FF00FF]" style="width:${Math.max(0, statsRef.current.fuel)}%"></div></div>`
              }
           </div>
         `;
      }

      // --- Rendering (Glitch Art Canvas) ---
      const w = canvas.width;
      const h = canvas.height;
      
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      // Camera tracking
      const camYOffset = h * 0.6;
      ctx.translate(w / 2 - chassis.position.x, camYOffset - chassis.position.y);

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#00FFFF';
      ctx.shadowColor = '#00FFFF';
      ctx.shadowBlur = 10;

      // Draw Terrain Wires
      ctx.beginPath();
      // We only draw the top edge for the cool wireframe look
      ctx.moveTo(activeTerrainBodies[0]?.position.x || 0, getTerrainY(activeTerrainBodies[0]?.position.x || 0));
      activeTerrainBodies.forEach(b => {
         // Instead of full body, draw the procedural curve to ensure a smooth bright line
         ctx.lineTo(b.position.x, getTerrainY(b.position.x));
      });
      ctx.stroke();

      // Draw active bodies (decorating the underside)
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.4)';
      ctx.shadowBlur = 0;
      activeTerrainBodies.forEach(b => {
        if (b.position.x > chassis.position.x - w && b.position.x < chassis.position.x + w) {
           ctx.beginPath();
           b.vertices.forEach((v, i) => {
              if (i === 0) ctx.moveTo(v.x, v.y);
              else ctx.lineTo(v.x, v.y);
           });
           ctx.lineTo(b.vertices[0].x, b.vertices[0].y);
           ctx.stroke();
        }
      });

      // Draw Collectables
      ctx.strokeStyle = '#FF00FF';
      ctx.shadowColor = '#FF00FF';
      ctx.shadowBlur = 20;
      collectableBodies.forEach(b => {
         if (b.label === 'collected') return;
         ctx.save();
         ctx.translate(b.position.x, b.position.y);
         ctx.rotate(time * 0.005);
         ctx.strokeRect(-20, -20, 40, 40);
         // Inner cross
         ctx.beginPath();
         ctx.moveTo(-10, 0); ctx.lineTo(10, 0);
         ctx.moveTo(0, -10); ctx.lineTo(0, 10);
         ctx.stroke();
         ctx.restore();
      });

      // Draw Car
      ctx.shadowColor = '#00FFFF';
      ctx.shadowBlur = 15;
      ctx.strokeStyle = '#00FFFF';
      
      // Chassis
      ctx.save();
      ctx.translate(chassis.position.x, chassis.position.y);
      ctx.rotate(chassis.angle);
      ctx.strokeRect(-60, -15, 120, 30);
      
      // Detail lines on chassis
      ctx.beginPath();
      ctx.moveTo(-40, 0); ctx.lineTo(40, 0);
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.stroke();
      ctx.restore();

      // Wheels
      const drawWheel = (wheel: Matter.Body) => {
        ctx.save();
        ctx.translate(wheel.position.x, wheel.position.y);
        ctx.rotate(wheel.angle);
        ctx.beginPath();
        ctx.arc(0, 0, 22, 0, Math.PI * 2);
        ctx.moveTo(0, 0); ctx.lineTo(22, 0); // Spoke
        ctx.moveTo(0, 0); ctx.lineTo(-22, 0);
        ctx.moveTo(0, 0); ctx.lineTo(0, 22);
        ctx.moveTo(0, 0); ctx.lineTo(0, -22);
        ctx.stroke();
        ctx.restore();
      }
      
      ctx.strokeStyle = '#FF00FF'; // Mageta wheels
      ctx.shadowColor = '#FF00FF';
      drawWheel(wheelA);
      drawWheel(wheelB);

      // Springs
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(chassis.position.x - 45 * Math.cos(chassis.angle) - 15 * Math.sin(chassis.angle), chassis.position.y - 45 * Math.sin(chassis.angle) + 15 * Math.cos(chassis.angle));
      ctx.lineTo(wheelA.position.x, wheelA.position.y);
      ctx.moveTo(chassis.position.x + 45 * Math.cos(chassis.angle) - 15 * Math.sin(chassis.angle), chassis.position.y + 45 * Math.sin(chassis.angle) + 15 * Math.cos(chassis.angle));
      ctx.lineTo(wheelB.position.x, wheelB.position.y);
      ctx.stroke();

      ctx.restore();

      animFrame = requestAnimationFrame(loop);
    };

    animFrame = requestAnimationFrame(loop);

    return () => {
       cancelAnimationFrame(animFrame);
       window.removeEventListener('keydown', handleKeyDown);
       window.removeEventListener('keyup', handleKeyUp);
       Matter.Engine.clear(engine);
    };
  }, [gameState, activeMode]);


  // Helper for restarting
  const restart = () => {
    statsRef.current = { distance: 0, fuel: 100, time: 60, speed: 0 };
    setGameState('running');
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-mono relative overflow-hidden flex flex-col pt-6 px-6">
      <div className="noise-bg"></div>
      <div className="crt-overlay"></div>

      <header className="border-b-4 border-[#FF00FF] pb-4 flex justify-between items-end relative z-10">
        <div>
          <span className="text-[#00FFFF] text-sm font-bold tracking-widest mb-1 flex items-center gap-2">
            <div className={`w-3 h-3 ${gameState === 'running' ? 'bg-[#00FFFF] animate-pulse' : 'bg-red-600'}`}></div> 
            {gameState === 'running' ? 'LINK_ACTIVE' : 'STANDBY'}
          </span>
          <h1 className="text-4xl text-[#FF00FF]">
            <GlitchText text="ROVER_PROTOCOL_v2.1" active={gameState === 'running'} />
          </h1>
        </div>
        <div className="text-right text-xs opacity-80 flex flex-col gap-1 items-end">
          <div className="bg-[#FF00FF] text-black px-2 py-1 font-bold">PHYSICS: ONLINE</div>
          <div className="text-[#00FFFF]">CHASSIS: 2-WHEEL SUSPENSION</div>
        </div>
      </header>

      <main className="flex-1 mt-6 relative border-glitch flex flex-col" ref={containerRef}>
        
        {/* Game HUD */}
        {gameState === 'running' && (
           <div className="absolute top-4 left-4 z-20 bg-black/80 border-2 border-[#00FFFF] p-4 text-xl shadow-[4px_4px_0_0_#FF00FF]" ref={hudRef}>
             {/* HUD Content injected via directly avoiding re-renders */}
           </div>
        )}

        {/* Physics Canvas */}
        {gameState === 'running' && (
           <canvas className="w-full flex-1 block" ref={canvasRef} />
        )}

        {/* Dynamic Mode Selection Menu */}
        {gameState === 'menu' && (
           <div className="absolute inset-0 bg-[#0a0a0a]/90 z-30 flex flex-col items-center justify-center p-8 text-center backdrop-blur-sm">
             <h2 className="text-[#00FFFF] text-2xl font-bold mb-8 uppercase tracking-widest border-b-2 border-dotted border-[#00FFFF] pb-2">
               Select Simulation Protocol
             </h2>
             <div className="flex gap-6 max-w-4xl w-full">
               
               <div onClick={() => { setActiveMode('classic'); setGameState('running'); statsRef.current.fuel = 100; }}
                    className="flex-1 border-2 border-[#FF00FF] bg-black p-6 cursor-pointer hover:bg-[#FF00FF]/20 transition-colors group relative overflow-hidden">
                  <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,0,255,0.1)_50%,transparent_75%)] bg-[length:10px_10px]" />
                  <h3 className="text-[#FF00FF] text-2xl font-bold mb-2 group-hover:-translate-y-1 transition-transform">CLASSIC</h3>
                  <p className="text-sm text-gray-400">Grav [g=1]. Constant traversal. Maintain energy reserves.</p>
               </div>

               <div onClick={() => { setActiveMode('time_trial'); setGameState('running'); statsRef.current.time = 60; }}
                    className="flex-1 border-2 border-[#00FFFF] bg-black p-6 cursor-pointer hover:bg-[#00FFFF]/20 transition-colors group relative overflow-hidden">
                  <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(0,255,255,0.1)_50%,transparent_75%)] bg-[length:10px_10px]" />
                  <h3 className="text-[#00FFFF] text-2xl font-bold mb-2 group-hover:-translate-y-1 transition-transform">TIME_TRIAL</h3>
                  <p className="text-sm text-gray-400">No fuel limits. Temporal constraints active. Collect checkpoints.</p>
               </div>

               <div onClick={() => { setActiveMode('low_gravity'); setGameState('running'); statsRef.current.fuel = 100; }}
                    className="flex-1 border-2 border-white bg-black p-6 cursor-pointer hover:bg-white/20 transition-colors group relative overflow-hidden">
                  <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,255,255,0.1)_50%,transparent_75%)] bg-[length:10px_10px]" />
                  <h3 className="text-white text-2xl font-bold mb-2 group-hover:-translate-y-1 transition-transform">LUNAR</h3>
                  <p className="text-sm text-gray-400">Grav [g=0.3]. High altitude risks. Maintain energy reserves.</p>
               </div>

             </div>
           </div>
        )}

        {/* Game Over Screen */}
        {gameState === 'gameover' && (
           <div className="absolute inset-0 bg-[#FF00FF]/10 z-30 flex flex-col items-center justify-center p-8 text-center backdrop-blur-md">
             <div className="bg-black border-4 border-[#FF00FF] p-10 max-w-lg shadow-[8px_8px_0_0_#00FFFF]">
               <h2 className="text-[#FF00FF] text-4xl font-bold mb-4 tearing uppercase">Mission Failure</h2>
               <p className="text-xl mb-6 text-gray-300">
                 Final Range: <span className="text-[#00FFFF] font-bold">{statsRef.current.distance}m</span>
               </p>
               <div className="flex gap-4 w-full">
                  <button onClick={restart} className="flex-1 px-4 py-3 bg-[#00FFFF] text-black font-bold uppercase hover:bg-white transition-colors cursor-pointer">
                    Re-Deploy
                  </button>
                  <button onClick={() => setGameState('menu')} className="flex-1 px-4 py-3 border-2 border-[#00FFFF] text-[#00FFFF] font-bold uppercase hover:bg-[#00FFFF]/20 transition-colors cursor-pointer">
                    Main Menu
                  </button>
               </div>
             </div>
           </div>
        )}
      </main>

      <footer className="mt-4 text-center text-xs text-[#00FFFF]/50 mb-2 relative z-10 flex justify-between uppercase">
        <span>CTRL: [A/D] or [Left/Right Arrow] To Accelerate & Rotate</span>
        <span>SYS.V_2026.04</span>
      </footer>

    </div>
  );
}
