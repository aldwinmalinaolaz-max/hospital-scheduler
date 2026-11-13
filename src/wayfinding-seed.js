// Starting wayfinding data for the ZRMC campus map (seed/campus-map.jpg, cropped from the
// Master Development Plan 2025). Positions are percentages of the image width and height.
// Staff can change everything in Staff Panel -> Directory -> Wayfinding; this is only loaded
// once into a database that has no campus map yet.
module.exports = {
  title: 'ZRMC Campus Map',
  description: 'Based on the Master Development Plan 2025 (not to scale). Buildings numbered 31-42 and the colored DPWH roads are proposed and not yet built.',
  image: 'seed/campus-map.jpg',
  width_m: 315,
  points: [
    {
      "key": "1",
      "code": "1",
      "name": "E.R. BUILDING",
      "kind": "BUILDING",
      "x": 38.82,
      "y": 28.14,
      "is_start": true
    },
    {
      "key": "2",
      "code": "2",
      "name": "MAIN WARD BUILDING",
      "kind": "BUILDING",
      "x": 47.76,
      "y": 40.83,
      "is_start": false
    },
    {
      "key": "3",
      "code": "3",
      "name": "RADIOLOGY BUILDING",
      "kind": "BUILDING",
      "x": 57.53,
      "y": 51.86,
      "is_start": false
    },
    {
      "key": "4",
      "code": "4",
      "name": "OR / DR BUILDING COMPLEX (P1)",
      "kind": "BUILDING",
      "x": 60.59,
      "y": 56.9,
      "is_start": false
    },
    {
      "key": "4A",
      "code": "4A",
      "name": "OR / DR BUILDING COMPLEX (P2)",
      "kind": "BUILDING",
      "x": 63.29,
      "y": 60.41,
      "is_start": false
    },
    {
      "key": "5",
      "code": "5",
      "name": "OUTPATIENT DEPARTMENT (OPD) BUILDING",
      "kind": "BUILDING",
      "x": 46.88,
      "y": 22.76,
      "is_start": true
    },
    {
      "key": "5A",
      "code": "5A",
      "name": "OPD WAITING AREA",
      "kind": "BUILDING",
      "x": 42.12,
      "y": 19.52,
      "is_start": false
    },
    {
      "key": "5B",
      "code": "5B",
      "name": "DOCTOR'S QUARTERS / LIBRARY",
      "kind": "BUILDING",
      "x": 46.06,
      "y": 16.55,
      "is_start": false
    },
    {
      "key": "6",
      "code": "6",
      "name": "ADMINISTRATIVE BUILDING",
      "kind": "BUILDING",
      "x": 56.24,
      "y": 32.9,
      "is_start": false
    },
    {
      "key": "7",
      "code": "7",
      "name": "NEW DIETARY BUILDING",
      "kind": "BUILDING",
      "x": 61.29,
      "y": 40.9,
      "is_start": false
    },
    {
      "key": "8",
      "code": "8",
      "name": "ENGINEERING AND FACILITIES BUILDING",
      "kind": "BUILDING",
      "x": 66.12,
      "y": 47.31,
      "is_start": false
    },
    {
      "key": "9",
      "code": "9",
      "name": "SUPPLY BUILDING (MMU)",
      "kind": "BUILDING",
      "x": 69.41,
      "y": 51.86,
      "is_start": false
    },
    {
      "key": "10",
      "code": "10",
      "name": "HALFWAY HOUSE / TB DOTS BUILDING",
      "kind": "BUILDING",
      "x": 78.53,
      "y": 66.9,
      "is_start": false
    },
    {
      "key": "10A",
      "code": "10A",
      "name": "CARPENTRY, PLUMBING AND ELECTRICAL WORKSHOP",
      "kind": "BUILDING",
      "x": 74.65,
      "y": 63.59,
      "is_start": false
    },
    {
      "key": "11",
      "code": "11",
      "name": "OINTMENT MANUFACTURING AND COMPOUNDING BUILDING",
      "kind": "BUILDING",
      "x": 76.82,
      "y": 75.86,
      "is_start": false
    },
    {
      "key": "12",
      "code": "12",
      "name": "PALLIATIVE BUILDING",
      "kind": "BUILDING",
      "x": 74.06,
      "y": 73.1,
      "is_start": false
    },
    {
      "key": "13",
      "code": "13",
      "name": "STAGE / ACTIVITY AREA",
      "kind": "BUILDING",
      "x": 66.65,
      "y": 65.93,
      "is_start": false
    },
    {
      "key": "14",
      "code": "14",
      "name": "ISOLATION WARD (NEGATIVE PRESSURE)",
      "kind": "BUILDING",
      "x": 64.29,
      "y": 75.31,
      "is_start": false
    },
    {
      "key": "15",
      "code": "15",
      "name": "ANNEX WARD B BUILDING",
      "kind": "BUILDING",
      "x": 56.59,
      "y": 67.31,
      "is_start": false
    },
    {
      "key": "16",
      "code": "16",
      "name": "ICU BUILDING",
      "kind": "BUILDING",
      "x": 51.94,
      "y": 59.03,
      "is_start": false
    },
    {
      "key": "17",
      "code": "17",
      "name": "OLD DIETARY BUILDING",
      "kind": "BUILDING",
      "x": 46.18,
      "y": 52.97,
      "is_start": false
    },
    {
      "key": "18",
      "code": "18",
      "name": "MEDICAL / SURGICAL WARD BUILDING",
      "kind": "BUILDING",
      "x": 38.65,
      "y": 45.17,
      "is_start": false
    },
    {
      "key": "19",
      "code": "19",
      "name": "LINEN AND LAUNDRY BUILDING",
      "kind": "BUILDING",
      "x": 45.12,
      "y": 63.03,
      "is_start": false
    },
    {
      "key": "20",
      "code": "20",
      "name": "OB-GYNE / PEDIA WARD BUILDING",
      "kind": "BUILDING",
      "x": 49.18,
      "y": 64.14,
      "is_start": false
    },
    {
      "key": "20A",
      "code": "20A",
      "name": "OB-GYNE / PEDIA WARD BUILDING (PHASE 2)",
      "kind": "BUILDING",
      "x": 52.53,
      "y": 70.83,
      "is_start": false
    },
    {
      "key": "21",
      "code": "21",
      "name": "HAZARDOUS WASTE FACILITY",
      "kind": "BUILDING",
      "x": 42.47,
      "y": 70.0,
      "is_start": false
    },
    {
      "key": "22",
      "code": "22",
      "name": "BUCAS BUILDING",
      "kind": "BUILDING",
      "x": 31.29,
      "y": 34.28,
      "is_start": false
    },
    {
      "key": "22A",
      "code": "22A",
      "name": "TRIAGE BUILDING",
      "kind": "BUILDING",
      "x": 29.76,
      "y": 23.66,
      "is_start": false
    },
    {
      "key": "23",
      "code": "23",
      "name": "GUARD HOUSE",
      "kind": "BUILDING",
      "x": 29.53,
      "y": 18.69,
      "is_start": false
    },
    {
      "key": "24",
      "code": "24",
      "name": "2-STOREY MULTI-PURPOSE BUILDING",
      "kind": "BUILDING",
      "x": 62.24,
      "y": 19.59,
      "is_start": false
    },
    {
      "key": "26",
      "code": "26",
      "name": "NEW POWER HOUSE",
      "kind": "BUILDING",
      "x": 72.47,
      "y": 41.52,
      "is_start": false
    },
    {
      "key": "27",
      "code": "27",
      "name": "DIESEL STORAGE",
      "kind": "BUILDING",
      "x": 75.47,
      "y": 46.07,
      "is_start": false
    },
    {
      "key": "28",
      "code": "28",
      "name": "MORGUE",
      "kind": "BUILDING",
      "x": 22.35,
      "y": 39.86,
      "is_start": false
    },
    {
      "key": "29",
      "code": "29",
      "name": "AUTOCLAVE BUILDING",
      "kind": "BUILDING",
      "x": 21.53,
      "y": 43.1,
      "is_start": false
    },
    {
      "key": "30",
      "code": "30",
      "name": "MODULAR HOSPITAL BUILDINGS",
      "kind": "BUILDING",
      "x": 8.82,
      "y": 79.52,
      "is_start": false
    },
    {
      "key": "G1",
      "code": null,
      "name": "MAIN GATE (PASOBOLONG ROAD)",
      "kind": "GATE",
      "x": 36.18,
      "y": 17.38,
      "is_start": true
    },
    {
      "key": "G2",
      "code": null,
      "name": "BACK GATE (PASOBOLONG ROAD)",
      "kind": "GATE",
      "x": 75.88,
      "y": 12.76,
      "is_start": true
    },
    {
      "key": "W1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 32.94,
      "y": 20.14,
      "is_start": false
    },
    {
      "key": "W2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 26.76,
      "y": 24.83,
      "is_start": false
    },
    {
      "key": "W3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 23.53,
      "y": 35.86,
      "is_start": false
    },
    {
      "key": "W4",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 19.41,
      "y": 48.28,
      "is_start": false
    },
    {
      "key": "W5",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 13.06,
      "y": 62.07,
      "is_start": false
    },
    {
      "key": "W5B",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 6.59,
      "y": 68.97,
      "is_start": false
    },
    {
      "key": "W6",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 10.88,
      "y": 77.24,
      "is_start": false
    },
    {
      "key": "J1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 40.29,
      "y": 22.76,
      "is_start": false
    },
    {
      "key": "J2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 46.47,
      "y": 28.28,
      "is_start": false
    },
    {
      "key": "J3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 50.0,
      "y": 29.79,
      "is_start": false
    },
    {
      "key": "P",
      "code": null,
      "name": "CENTRAL PLAZA",
      "kind": "LANDMARK",
      "x": 53.24,
      "y": 33.79,
      "is_start": true
    },
    {
      "key": "N1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 57.94,
      "y": 26.76,
      "is_start": false
    },
    {
      "key": "N2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 63.53,
      "y": 24.83,
      "is_start": false
    },
    {
      "key": "N3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 70.88,
      "y": 18.62,
      "is_start": false
    },
    {
      "key": "M1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 58.82,
      "y": 41.38,
      "is_start": false
    },
    {
      "key": "M2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 63.24,
      "y": 47.45,
      "is_start": false
    },
    {
      "key": "M3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 67.35,
      "y": 52.97,
      "is_start": false
    },
    {
      "key": "M4",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 71.47,
      "y": 58.97,
      "is_start": false
    },
    {
      "key": "M5",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 67.65,
      "y": 68.97,
      "is_start": false
    },
    {
      "key": "S1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 69.71,
      "y": 44.14,
      "is_start": false
    },
    {
      "key": "X1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 35.29,
      "y": 32.41,
      "is_start": false
    },
    {
      "key": "C1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 55.88,
      "y": 48.28,
      "is_start": false
    },
    {
      "key": "C2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 49.12,
      "y": 55.52,
      "is_start": false
    },
    {
      "key": "C3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 45.29,
      "y": 60.69,
      "is_start": false
    },
    {
      "key": "K1",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 43.82,
      "y": 21.03,
      "is_start": false
    },
    {
      "key": "K2",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 76.47,
      "y": 64.83,
      "is_start": false
    },
    {
      "key": "K3",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 72.35,
      "y": 71.72,
      "is_start": false
    },
    {
      "key": "K4",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 50.59,
      "y": 67.24,
      "is_start": false
    },
    {
      "key": "K5",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 53.82,
      "y": 63.1,
      "is_start": false
    },
    {
      "key": "K6",
      "code": null,
      "name": "",
      "kind": "JUNCTION",
      "x": 60.59,
      "y": 71.72,
      "is_start": false
    }
  ],
  paths: [["G1", "W1"], ["W1", "23"], ["W1", "W2"], ["W2", "22A"], ["W2", "W3"], ["W3", "28"], ["W3", "29"], ["W3", "W4"], ["W4", "W5"], ["W5", "W5B"], ["W5B", "W6"], ["W6", "30"], ["G1", "J1"], ["W1", "J1"], ["J1", "K1"], ["K1", "5A"], ["K1", "5B"], ["J1", "1"], ["J1", "J2"], ["J2", "5"], ["J2", "J3"], ["J3", "P"], ["J3", "5"], ["J3", "N1"], ["N1", "N2"], ["N2", "24"], ["N2", "N3"], ["N3", "G2"], ["P", "6"], ["P", "2"], ["P", "M1"], ["M1", "7"], ["M1", "C1"], ["M1", "M2"], ["M2", "8"], ["M2", "M3"], ["M3", "9"], ["M3", "M4"], ["M3", "S1"], ["S1", "26"], ["S1", "27"], ["M4", "K2"], ["K2", "10A"], ["K2", "10"], ["M4", "M5"], ["M5", "13"], ["M5", "K3"], ["K3", "12"], ["K3", "11"], ["M5", "14"], ["J1", "X1"], ["X1", "1"], ["X1", "22"], ["X1", "18"], ["C1", "2"], ["C1", "3"], ["C1", "4"], ["4A", "M4"], ["C1", "C2"], ["C2", "17"], ["C2", "16"], ["C2", "18"], ["C2", "C3"], ["C3", "19"], ["C3", "21"], ["C2", "20"], ["C3", "K4"], ["K4", "20A"], ["C2", "K5"], ["K5", "16"], ["K5", "15"], ["K5", "K6"], ["K6", "14"], ["K6", "M5"]],
  // Directory places linked to buildings (by building no.); OPD_CLINICS = every OPD clinic entry
  links: { 'Emergency Room': '1', OPD_CLINICS: '5' },
};
