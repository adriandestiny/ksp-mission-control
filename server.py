"""
KSP Mission Control Server
Connects to kRPC mod in KSP and serves an Artemis-styled mission control dashboard.
"""

import threading
import time
import json
import math
import os
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder="static")
CORS(app)

# ─── Telemetry State ────────────────────────────────────────────────────────

telemetry = {
    "connected": False,
    "ksp_version": "N/A",
    "server_version": "N/A",
    # FLIGHT
    "vessel_name": "No Active Vessel",
    "situation": "UNKNOWN",
    "met": 0.0,
    "ut": 0.0,
    "mission_phase": "PRE-LAUNCH",
    # FDO – Flight Dynamics
    "apoapsis": 0.0,
    "periapsis": 0.0,
    "inclination": 0.0,
    "eccentricity": 0.0,
    "time_to_apoapsis": 0.0,
    "time_to_periapsis": 0.0,
    "orbital_speed": 0.0,
    "orbital_period": 0.0,
    "semi_major_axis": 0.0,
    "altitude": 0.0,
    "surface_altitude": 0.0,
    # GNC – Guidance, Navigation, Control
    "heading": 0.0,
    "pitch": 0.0,
    "roll": 0.0,
    "angular_velocity_x": 0.0,
    "angular_velocity_y": 0.0,
    "angular_velocity_z": 0.0,
    "surface_speed": 0.0,
    "vertical_speed": 0.0,
    "latitude": 0.0,
    "longitude": 0.0,
    # PROP – Propulsion
    "twr": 0.0,
    "thrust": 0.0,
    "max_thrust": 0.0,
    "isp": 0.0,
    "specific_impulse": 0.0,
    "total_mass": 0.0,
    "dry_mass": 0.0,
    "fuel_lf": 0.0,
    "fuel_lf_max": 0.0,
    "fuel_ox": 0.0,
    "fuel_ox_max": 0.0,
    "fuel_mono": 0.0,
    "fuel_mono_max": 0.0,
    "delta_v_total": 0.0,
    # MPO – Mechanical & Power
    "electric_charge": 0.0,
    "electric_charge_max": 0.0,
    "part_count": 0,
    "crew_capacity": 0,
    "crew_count": 0,
    # EECOM – Environmental & Consumables
    "solid_fuel": 0.0,
    "solid_fuel_max": 0.0,
    "ablator": 0.0,
    "ablator_max": 0.0,
    "xenon": 0.0,
    "xenon_max": 0.0,
    # CONTROL – SAS/RCS/Throttle
    "throttle": 0.0,
    "sas_enabled": False,
    "rcs_enabled": False,
    "gear_deployed": False,
    "brakes_active": False,
    "lights_on": False,
    "action_groups": {},
    # INCO – Communications
    "comms_signal": 0.0,
    "comms_can_communicate": False,
    # BOOSTER – Launch Vehicle Stage Info
    "stage_count": 0,
    "current_stage": 0,
    "engines_active": 0,
    "engines_total": 0,
    # FAO – Flight Activities / Maneuver Nodes
    "has_maneuver_node": False,
    "node_delta_v": 0.0,
    "node_burn_time": 0.0,
    "time_to_node": 0.0,
    "target_name": "None",
    "target_distance": 0.0,
    "target_relative_velocity": 0.0,
    # GC – Ground Control / Body
    "body_name": "Kerbin",
    "body_radius": 600000.0,
    "body_mu": 3.5316e12,
    # Timestamps
    "last_update": 0.0,
}

_krpc_conn = None
_krpc_lock = threading.Lock()
_poll_interval = 0.5  # seconds


# ─── kRPC Connection Thread ──────────────────────────────────────────────────

def format_time(seconds):
    seconds = abs(int(seconds))
    d = seconds // 86400
    h = (seconds % 86400) // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if d > 0:
        return f"{d}d {h:02d}:{m:02d}:{s:02d}"
    return f"{h:02d}:{m:02d}:{s:02d}"


def safe_get(func, default=0.0):
    try:
        return func()
    except Exception:
        return default


def poll_krpc():
    global _krpc_conn, telemetry

    while True:
        try:
            import krpc
            print("[kRPC] Attempting to connect to KSP…")
            conn = krpc.connect(name="Artemis Mission Control", address="127.0.0.1",
                                rpc_port=50000, stream_port=50001)
            print("[kRPC] Connected!")
            _krpc_conn = conn

            with _krpc_lock:
                telemetry["connected"] = True
                telemetry["ksp_version"] = str(safe_get(lambda: conn.krpc.get_status().version, "N/A"))

            while True:
                sc = conn.space_center
                vessel = safe_get(lambda: sc.active_vessel, None)

                if vessel is None:
                    with _krpc_lock:
                        telemetry["vessel_name"] = "No Active Vessel"
                        telemetry["situation"] = "UNKNOWN"
                        telemetry["last_update"] = time.time()
                    time.sleep(1)
                    continue

                # Reference frames
                orbit_frame = vessel.orbital_reference_frame
                surface_frame = vessel.surface_reference_frame
                body = vessel.orbit.body

                # Orbit
                orb = vessel.orbit
                flight_orb = vessel.flight(orbit_frame)
                flight_srf = vessel.flight(surface_frame)

                # Resources
                resources = vessel.resources

                def get_resource(name):
                    try:
                        return resources.amount(name), resources.max(name)
                    except Exception:
                        return 0.0, 0.0

                lf, lf_max = get_resource("LiquidFuel")
                ox, ox_max = get_resource("Oxidizer")
                mono, mono_max = get_resource("MonoPropellant")
                ec, ec_max = get_resource("ElectricCharge")
                sf, sf_max = get_resource("SolidFuel")
                ab, ab_max = get_resource("Ablator")
                xe, xe_max = get_resource("XenonGas")

                # Control
                ctrl = vessel.control
                ap = vessel.auto_pilot

                # Engines
                engines = [p.engine for p in vessel.parts.all if p.engine is not None]
                active_engines = [e for e in engines if e.active]
                engines_thrust = sum(safe_get(lambda: e.thrust, 0.0) for e in active_engines)
                engines_max_thrust = sum(safe_get(lambda: e.max_thrust, 0.0) for e in engines)

                # Delta-V
                dv_total = 0.0
                try:
                    for stage in vessel.delta_v.stages:
                        dv_total += stage.delta_v_vacuum
                except Exception:
                    pass

                # Specific impulse (average)
                isp_val = 0.0
                if active_engines:
                    try:
                        isp_val = sum(e.specific_impulse for e in active_engines) / len(active_engines)
                    except Exception:
                        pass

                # TWR
                mass = safe_get(lambda: vessel.mass, 1.0)
                gravity = safe_get(lambda: body.surface_gravity, 9.81)
                twr_val = (engines_thrust / (mass * gravity)) if mass > 0 and gravity > 0 else 0.0

                # Situation
                sit_map = {
                    sc.VesselSituation.pre_launch: "PRE-LAUNCH",
                    sc.VesselSituation.landed: "LANDED",
                    sc.VesselSituation.splashed: "SPLASHED DOWN",
                    sc.VesselSituation.flying: "ATMOSPHERIC FLIGHT",
                    sc.VesselSituation.sub_orbital: "SUB-ORBITAL",
                    sc.VesselSituation.orbiting: "ORBITING",
                    sc.VesselSituation.escaping: "ESCAPING",
                    sc.VesselSituation.docked: "DOCKED",
                }
                situation = sit_map.get(safe_get(lambda: vessel.situation), "UNKNOWN")

                # Maneuver node
                has_node = False
                node_dv = 0.0
                node_burn = 0.0
                node_time = 0.0
                try:
                    nodes = ctrl.nodes
                    if nodes:
                        n = nodes[0]
                        has_node = True
                        node_dv = safe_get(lambda: n.delta_v, 0.0)
                        node_burn = safe_get(lambda: n.remaining_burn_vector(vessel.orbital_reference_frame), (0,0,0))
                        node_burn = math.sqrt(sum(x**2 for x in node_burn))
                        node_time = safe_get(lambda: n.ut - sc.ut, 0.0)
                except Exception:
                    pass

                # Target
                target_name = "None"
                target_dist = 0.0
                target_rel_v = 0.0
                try:
                    tgt = sc.target_vessel or sc.target_body
                    if tgt:
                        target_name = safe_get(lambda: tgt.name, "Unknown")
                        target_dist = safe_get(lambda: vessel.orbit.distance_at_closest_approach(tgt.orbit), 0.0)
                        target_rel_v = safe_get(lambda: vessel.velocity(sc.target_vessel.orbital_reference_frame) if sc.target_vessel else (0,0,0), (0,0,0))
                        if isinstance(target_rel_v, tuple):
                            target_rel_v = math.sqrt(sum(x**2 for x in target_rel_v))
                except Exception:
                    pass

                # Comms
                comms_signal = 0.0
                comms_can = False
                try:
                    comms = vessel.comms
                    comms_signal = safe_get(lambda: comms.signal_strength, 0.0)
                    comms_can = safe_get(lambda: comms.can_communicate, False)
                except Exception:
                    pass

                # Angular velocity
                av = safe_get(lambda: flight_srf.angular_velocity, (0, 0, 0))

                ut = safe_get(lambda: sc.ut, 0.0)
                met = safe_get(lambda: vessel.met, 0.0)

                # Mission phase
                if situation in ("PRE-LAUNCH",):
                    phase = "PRE-LAUNCH"
                elif situation in ("LANDED", "SPLASHED DOWN"):
                    phase = "SURFACE OPS"
                elif situation == "ATMOSPHERIC FLIGHT":
                    phase = "ASCENT"
                elif situation == "SUB-ORBITAL":
                    phase = "SUB-ORBITAL"
                elif situation == "ORBITING":
                    phase = "ORBITAL OPS"
                elif situation == "ESCAPING":
                    phase = "TRANS-LUNAR"
                elif situation == "DOCKED":
                    phase = "DOCKED"
                else:
                    phase = "FLIGHT"

                with _krpc_lock:
                    telemetry.update({
                        "connected": True,
                        "vessel_name": safe_get(lambda: vessel.name, "Unknown"),
                        "situation": situation,
                        "met": met,
                        "ut": ut,
                        "mission_phase": phase,
                        # FDO
                        "apoapsis": safe_get(lambda: orb.apoapsis_altitude, 0.0),
                        "periapsis": safe_get(lambda: orb.periapsis_altitude, 0.0),
                        "inclination": math.degrees(safe_get(lambda: orb.inclination, 0.0)),
                        "eccentricity": safe_get(lambda: orb.eccentricity, 0.0),
                        "time_to_apoapsis": safe_get(lambda: orb.time_to_apoapsis, 0.0),
                        "time_to_periapsis": safe_get(lambda: orb.time_to_periapsis, 0.0),
                        "orbital_speed": safe_get(lambda: orb.speed, 0.0),
                        "orbital_period": safe_get(lambda: orb.period, 0.0),
                        "semi_major_axis": safe_get(lambda: orb.semi_major_axis, 0.0),
                        "altitude": safe_get(lambda: flight_orb.mean_altitude, 0.0),
                        "surface_altitude": safe_get(lambda: flight_srf.surface_altitude, 0.0),
                        # GNC
                        "heading": safe_get(lambda: flight_srf.heading, 0.0),
                        "pitch": safe_get(lambda: flight_srf.pitch, 0.0),
                        "roll": safe_get(lambda: flight_srf.roll, 0.0),
                        "angular_velocity_x": av[0] if isinstance(av, (list, tuple)) else 0.0,
                        "angular_velocity_y": av[1] if isinstance(av, (list, tuple)) else 0.0,
                        "angular_velocity_z": av[2] if isinstance(av, (list, tuple)) else 0.0,
                        "surface_speed": safe_get(lambda: flight_srf.speed, 0.0),
                        "vertical_speed": safe_get(lambda: flight_srf.vertical_speed, 0.0),
                        "latitude": safe_get(lambda: flight_srf.latitude, 0.0),
                        "longitude": safe_get(lambda: flight_srf.longitude, 0.0),
                        # PROP
                        "twr": twr_val,
                        "thrust": engines_thrust,
                        "max_thrust": engines_max_thrust,
                        "specific_impulse": isp_val,
                        "total_mass": mass,
                        "dry_mass": safe_get(lambda: vessel.dry_mass, 0.0),
                        "fuel_lf": lf,
                        "fuel_lf_max": lf_max,
                        "fuel_ox": ox,
                        "fuel_ox_max": ox_max,
                        "fuel_mono": mono,
                        "fuel_mono_max": mono_max,
                        "delta_v_total": dv_total,
                        # MPO
                        "electric_charge": ec,
                        "electric_charge_max": ec_max,
                        "part_count": safe_get(lambda: len(vessel.parts.all), 0),
                        "crew_capacity": safe_get(lambda: vessel.crew_capacity, 0),
                        "crew_count": safe_get(lambda: len(vessel.crew), 0),
                        # EECOM
                        "solid_fuel": sf,
                        "solid_fuel_max": sf_max,
                        "ablator": ab,
                        "ablator_max": ab_max,
                        "xenon": xe,
                        "xenon_max": xe_max,
                        # CONTROL
                        "throttle": safe_get(lambda: ctrl.throttle, 0.0),
                        "sas_enabled": safe_get(lambda: ctrl.sas, False),
                        "rcs_enabled": safe_get(lambda: ctrl.rcs, False),
                        "gear_deployed": safe_get(lambda: ctrl.gear, False),
                        "brakes_active": safe_get(lambda: ctrl.brakes, False),
                        "lights_on": safe_get(lambda: ctrl.lights, False),
                        # INCO
                        "comms_signal": comms_signal,
                        "comms_can_communicate": comms_can,
                        # BOOSTER
                        "stage_count": safe_get(lambda: vessel.control.current_stage, 0),
                        "current_stage": safe_get(lambda: vessel.control.current_stage, 0),
                        "engines_active": len(active_engines),
                        "engines_total": len(engines),
                        # FAO
                        "has_maneuver_node": has_node,
                        "node_delta_v": node_dv,
                        "node_burn_time": node_burn,
                        "time_to_node": node_time,
                        "target_name": target_name,
                        "target_distance": target_dist,
                        "target_relative_velocity": target_rel_v,
                        # GC
                        "body_name": safe_get(lambda: body.name, "Unknown"),
                        "body_radius": safe_get(lambda: body.equatorial_radius, 600000.0),
                        "body_mu": safe_get(lambda: body.gravitational_parameter, 3.5316e12),
                        "last_update": time.time(),
                    })

                time.sleep(_poll_interval)

        except ImportError:
            print("[kRPC] krpc module not installed. Install with: pip install krpc")
            with _krpc_lock:
                telemetry["connected"] = False
                telemetry["vessel_name"] = "kRPC library not installed"
            time.sleep(5)
        except Exception as e:
            print(f"[kRPC] Connection error: {e}")
            with _krpc_lock:
                telemetry["connected"] = False
                telemetry["vessel_name"] = "Disconnected – awaiting KSP"
            time.sleep(3)


# ─── Flask Routes ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


@app.route("/api/telemetry")
def api_telemetry():
    with _krpc_lock:
        return jsonify(dict(telemetry))


@app.route("/api/status")
def api_status():
    with _krpc_lock:
        return jsonify({
            "connected": telemetry["connected"],
            "vessel_name": telemetry["vessel_name"],
            "last_update": telemetry["last_update"],
        })


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("  KSP Artemis Mission Control Server")
    print("=" * 60)
    print("  Dashboard: http://localhost:5000")
    print("  Telemetry API: http://localhost:5000/api/telemetry")
    print()
    print("  Make sure KSP is running with kRPC mod installed,")
    print("  and the kRPC server is started in-game.")
    print("=" * 60)

    t = threading.Thread(target=poll_krpc, daemon=True)
    t.start()

    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
