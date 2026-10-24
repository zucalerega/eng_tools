import { describe, expect, test } from "vitest";
import { keepsItsName, partNumberOf, vendorsName } from "../src/vault/paths";

// Part numbers' names, with the same cases as the server's tests/test_numbers.py: the web app and the server must
// agree on what's a part number.

describe("part numbers", () => {
    test.each([
        ["00000123-001.SLDPRT", "00000123-001", true],
        ["00000123-501.sldasm", "00000123-501", true],
        ["00000123-001", "00000123-001", true],
        ["00000123-001 - machining.SLDDRW", "00000123-001", false],
        ["00000123-001.PDF", "00000123-001", true],
        ["00000004-010-6.SLDPRT", "00000004-010", false],
        ["00000004-501 downloads backup.SLDASM", "00000004-501", false],
        ["99999999-999.STEP", "99999999-999", true],
    ])("%s is named by %s", (name, number, exact) => {
        expect(partNumberOf(name)).toEqual({ number, exact });
    });

    test.each([
        "Fin.SLDPRT",
        "0000123-001.SLDPRT",
        "000000123-001.SLDPRT",
        "00000123-01.SLDPRT",
        "00000123-0011.SLDPRT",
        "00000123-001a.SLDPRT",
        "00000123_001.SLDPRT",
        "91251A463_Socket Head Screw.SLDPRT",
        "1341617 VUVS-L20-COVER CAP.SLDPRT",
    ])("%s isn't", (name) => {
        expect(partNumberOf(name)).toBeNull();
    });

    test("parts, assemblies, and STEP and STL files keep their numbers; drawings and PDFs are named after them", () => {
        expect(["00000123-001.SLDPRT", "00000123-501.SLDASM", "00000123-001.STEP"].map(keepsItsName)).toEqual([
            true,
            true,
            true,
        ]);
        expect(["00000123-001.SLDDRW", "00000123-001.PDF", "Fin.SLDPRT"].map(keepsItsName)).toEqual([
            false,
            false,
            false,
        ]);
    });

    test.each([
        ["91251A463.SLDPRT", true],
        ["91251A463_Socket Head Screw.SLDPRT", true],
        ["5911K12 Ball Valve.SLDASM", true],
        ["90107a029.STEP", true],
        ["Fin.SLDPRT", false],
        ["00000123-001.SLDPRT", false],
        ["91251A463B.SLDPRT", false],
        ["102423 Stringer.SLDPRT", false],
    ])("%s is a vendor's: %s", (name, vendor) => {
        expect(vendorsName(name)).toBe(vendor);
    });
});
