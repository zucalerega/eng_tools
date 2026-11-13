"""Generated Luna Python API surface. DO NOT EDIT BY HAND.

Run scripts/generate_luna_contract.py against a Luna checkout.
Changes require simulator/test review before merge.
"""

SOURCE_HASHES = {'Cargo.lock': '8ef40d8fff29fe1fb456050fb40274c075a116e1a55147cd125b9edbc71b53a4',
 'common/Cargo.toml': '33aa366515397980aedc2d463a551a38b5e966ebeca3cc9e03d6d06675a6fb5f',
 'common/src/comm/flight.rs': '6db248ac2ceabde36792f2192025406174716b675681d008e1f25fa92df370e6',
 'common/src/comm/gui.rs': 'ef084e33e3f87be0dedc6b5b824748a3638db70fc7de24a80f43991d32def892',
 'common/src/comm/sam.rs': '1b40af6fa6eaa98d3f74423d3973e9727fd34296151473959d88ae9559c7bb22',
 'common/src/sequence/device.rs': '5b58bcf04989616a6f7327ddb8a30704f341d7dbb06c832db9c85d4d7f60857a',
 'common/src/sequence/func.rs': '5ec25ed3f449830e79432cc8590fc8e37520268a2cacf01f39be2834fe1cb8a0',
 'common/src/sequence/mod.rs': '5f6ece841e085b31a98a6142d6af568605af97b233db9ee1908164705f2b035b',
 'common/src/sequence/unit.rs': 'b28c04cf06599677029da5ee8c2c06675cb97efa36fde2bce2e47b7a9eb4ec1c',
 'flight2/src/sequence.rs': '0b54a64733760b873488a17fee744a68b7db30d1d28193af92ca4ef2ad495010',
 'gui/src/comm.tsx': 'bf7b962141f4cd23a16e5c5aac121e31f47ae6cb0301cdae3c938f613c58d47f',
 'gui/src/system/SystemPages.tsx': 'ccdea2ae123d02ebe0f51459239fe7f066699760dbbd06606abb7238eced6a78',
 'servo/src/server/routes/sequence.rs': 'a0aa1562d35e8d518cb3db5285d836769882819c26396254960bbb08203152cf'}

FUNCTIONS = {'abort': (),
 'aborted_in_this_stage': (),
 'clear_abort_status': (),
 'create_abort_stage': (('stage_name', 'String'),
                        ('abort_condition', 'String'),
                        ('safe_valve_states', '&PyDict')),
 'curr_abort_condition': (),
 'curr_abort_stage': (),
 'interval': (('count', 'i64'), ('period', 'Duration')),
 'launch_lug_arm': (('sam_hostname', 'String'), ('should_enable', 'bool')),
 'launch_lug_detonate': (('sam_hostname', 'String'), ('should_enable', 'bool')),
 'read_umbilical_voltage': (),
 'reco_init_ekf': (),
 'reco_recvd_launch': (),
 'sam_camera_toggle': (('should_enable', 'bool'),),
 'send_reco_launch': (),
 'set_abort_stage': (('stage_name', 'String'),),
 'set_servo_disconnect_abort': (('enabled', 'bool'),),
 'wait_for': (('duration', 'Duration'),),
 'wait_until': (('condition', '&PyAny'),
                ('timeout', 'Option<Duration>'),
                ('poll_interval', 'Option<Duration>'))}

METHODS = {'Sensor': {'read': ()},
 'Valve': {'actuate': (('open', 'bool'),), 'close': (), 'is_closed': (), 'is_open': (), 'open': ()}}

CONSTRUCTORS = {'Current': (('raw', 'f64'),),
 'Duration': (('raw', 'f64'),),
 'ElectricPotential': (('raw', 'f64'),),
 'Force': (('raw', 'f64'),),
 'Pressure': (('raw', 'f64'),),
 'Sensor': (('name', 'String'),),
 'Temperature': (('raw', 'f64'),),
 'Valve': (('name', 'String'),)}

UNIT_CLASSES = {'Current': 'A',
 'Duration': 's',
 'ElectricPotential': 'V',
 'Force': 'lbf',
 'Pressure': 'psi',
 'Temperature': 'K'}

UNIT_CONSTANTS = {'A': 'A',
 'K': 'K',
 'V': 'V',
 'lbf': 'lbf',
 'mA': 'A',
 'mV': 'V',
 'ms': 's',
 'psi': 'psi',
 's': 's',
 'us': 's'}

OTHER_CLASSES = {'IntervalIterator', 'ValveSafeState', 'ValveState'}

OTHER_EXPORTS = {'__layout_fingerprint__'}

PRELUDE = {'CLOSED', 'OPEN'}

VALVE_STATES = {'Closed', 'Disconnected', 'Fault', 'Open', 'Undetermined'}

SENSOR_COMPARISON_ORDER = 'reversed'


COMMON_EXPORTS = (set(FUNCTIONS) | set(CONSTRUCTORS) | set(UNIT_CONSTANTS) |
                  OTHER_CLASSES | OTHER_EXPORTS)
API = COMMON_EXPORTS | PRELUDE
