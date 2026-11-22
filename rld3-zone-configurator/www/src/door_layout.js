const COORDINATE_LIMIT_MM = 100000; // rld3_spatial_policy.h
const MAX_DOOR_TOLERANCE_MM = 65535; // uint16_t layout field

/** A wall opening, in room mm. Wall index follows the master vertex order. */
export function wallDoor(master, wall, startMm, endMm, toleranceMm) {
  if (!Array.isArray(master) || master.length < 3 || !Number.isInteger(wall)
      || wall < 0 || wall >= master.length || ![startMm,endMm,toleranceMm].every(Number.isFinite)
      || startMm < 0 || endMm <= startMm || !Number.isInteger(toleranceMm)
      || toleranceMm < 0 || toleranceMm > MAX_DOOR_TOLERANCE_MM) throw new Error('Invalid door segment or tolerance');
  const a=master[wall], b=master[(wall+1)%master.length];
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
  if (!length || endMm>length) throw new Error('Door endpoints must lie on the selected wall');
  const point=(u)=>({x:Math.round(a.x+u*dx/length),y:Math.round(a.y+u*dy/length)});
  const vertices=[point(startMm),point(endMm)];
  if (vertices[0].x===vertices[1].x && vertices[0].y===vertices[1].y) throw new Error('Door width is below one millimetre');
  return {vertices,toleranceMm};
}

/** Effective closed opening in wall mm, matching firmware door_wall/door_interval.
 * Endpoints may be reversed or quantised up to 1 mm off a wall. Returns a new
 * interval; never changes the master or door. Throws for invalid wall geometry.
 */
export function doorInterval(master, door) {
  if (!Array.isArray(master) || master.length < 3 || !door
      || !Array.isArray(door.vertices) || door.vertices.length !== 2
      || !Number.isInteger(door.toleranceMm) || door.toleranceMm < 0 || door.toleranceMm > MAX_DOOR_TOLERANCE_MM
      || ![...master, ...door.vertices].every(p => p && Number.isInteger(p.x) && Number.isInteger(p.y)
        && Math.abs(p.x) <= COORDINATE_LIMIT_MM && Math.abs(p.y) <= COORDINATE_LIMIT_MM)) {
    throw new Error('Door requires a master wall, two endpoints and an integer tolerance in mm');
  }
  const [start, end] = door.vertices;
  if (start.x === end.x && start.y === end.y) throw new Error('Door width is below one millimetre');
  for (let wall = 0; wall < master.length; wall++) {
    const a = master[wall], b = master[(wall + 1) % master.length];
    const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
    const first = (start.x - a.x) * dx + (start.y - a.y) * dy;
    const second = (end.x - a.x) * dx + (end.y - a.y) * dy;
    const crossStart = dx * (start.y - a.y) - dy * (start.x - a.x);
    const crossEnd = dx * (end.y - a.y) - dy * (end.x - a.x);
    if (lengthSq > 0 && crossStart * crossStart <= lengthSq && crossEnd * crossEnd <= lengthSq
        && first >= 0 && first <= lengthSq && second >= 0 && second <= lengthSq) {
      const length = Math.hypot(dx, dy);
      return {wall,
        lowMm: Math.max(0, Math.min(first / length, second / length) - door.toleranceMm),
        highMm: Math.min(length, Math.max(first / length, second / length) + door.toleranceMm)};
    }
  }
  throw new Error('Door endpoints must lie on the same master wall');
}

/** Refuse the first intersecting pair, including contact at one point. Pure,
 * synchronous preflight for Add door and restart writes (including imports).
 * Error names both doors, the wall and the clipped overlap in wall mm.
 */
export function assertDoorsDisjoint(master, doors = []) {
  const label = i => doors[i].name || `Door ${i + 1}`;
  const intervals = doors.map((door,i) => {try{return doorInterval(master,door);}catch(error){throw new Error(`${label(i)}: ${error.message}`);}});
  const mm = value => Number(value.toFixed(3));
  for (let i = 0; i < intervals.length; i++) {
    const a = intervals[i];
    for (let j = 0; j < i; j++) {
      const b = intervals[j];
      if (a.wall !== b.wall) continue;
      if (a.lowMm <= b.highMm && b.lowMm <= a.highMm) {
        throw new Error(`${label(i)} overlaps ${label(j)} on wall ${String.fromCharCode(65+a.wall)} between `
          + `${mm(Math.max(a.lowMm, b.lowMm))} and ${mm(Math.min(a.highMm, b.highMm))} mm (tolerance included)`);
      }
    }
  }
}

/** Project a pointer near a finite wall; extensions never count as wall hits. */
export function projectWall(master, point, maxDistanceMm, wallOnly = null) {
  let best = null;
  for (let wall=0; wall<(master?.length || 0); wall++) {
    if (wallOnly != null && wall !== wallOnly) continue;
    const a=master[wall], b=master[(wall+1)%master.length];
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if (!length) continue;
    const along=((point.x-a.x)*dx+(point.y-a.y)*dy)/length;
    if (along<0 || along>length) continue;
    const distance=Math.abs(dx*(point.y-a.y)-dy*(point.x-a.x))/length;
    if (distance<=maxDistanceMm && (!best || distance<best.distance)) best={wall,along,length,distance,point:{x:Math.round(a.x+along*dx/length),y:Math.round(a.y+along*dy/length)}};
  }
  return best;
}
export function doorFromPoints(master, first, second, toleranceMm=100, maxDistanceMm=100) {
  const a=projectWall(master,first,maxDistanceMm),b=projectWall(master,second,maxDistanceMm);
  if(!a || !b || a.wall!==b.wall) throw new Error('Click two points on the same room wall');
  return wallDoor(master,a.wall,Math.min(a.along,b.along),Math.max(a.along,b.along),toleranceMm);
}
/** Inward unit normal at a straight boundary, independent of winding. */
export function doorNormal(master, door) {
  const {wall}=doorInterval(master,door),a=master[wall],b=master[(wall+1)%master.length];
  const area=master.reduce((sum,p,i)=>{const q=master[(i+1)%master.length];return sum+p.x*q.y-q.x*p.y;},0);
  const length=Math.hypot(b.x-a.x,b.y-a.y),sign=area>=0?1:-1;
  return {x:-(b.y-a.y)/length*sign,y:(b.x-a.x)/length*sign};
}
/** Move an opening/end along its existing wall. Failure leaves the caller intact. */
export function moveDoor(master, door, deltaMm, end = null) {
  const {wall}=doorInterval(master,door),a=master[wall],b=master[(wall+1)%master.length];
  const length=Math.hypot(b.x-a.x,b.y-a.y);
  const along=p=>((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/length;
  const distances=door.vertices.map(along).sort((a,b)=>a-b);
  if(end==null) { const shift=Math.max(-distances[0],Math.min(length-distances[1],deltaMm)); distances[0]+=shift;distances[1]+=shift; }
  else distances[end]=Math.max(0,Math.min(length,distances[end]+deltaMm));
  return {...door,...wallDoor(master,wall,distances[0],distances[1],door.toleranceMm)};
}
