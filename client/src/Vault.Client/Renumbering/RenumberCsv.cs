using System.Globalization;
using System.Text;

namespace Vault.Client.Renumbering;

/// <summary>
/// The plan and its review as CSV files, which the leads open in Excel: plan.csv says what each file becomes, and they
/// fill in vendors.csv (path), keep.csv (path, why), titles.csv (path, title), and kinds.csv (folder, part kind,
/// assembly kind; an empty folder is the top). Each has a header row.
/// </summary>
public static class RenumberCsv
{
    /// <summary>Excel reads a CSV file as UTF-8 only if it starts with the byte order mark.</summary>
    public static readonly Encoding Encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true);

    public static void WritePlan(TextWriter writer, RenumberPlan plan)
    {
        WriteRow(writer, "file_id", "path", "new_name", "number", "kind", "title", "role");
        foreach (var entry in plan.Renames)
        {
            WriteRow(writer, Id(entry.File), entry.File.Path, entry.NewName, entry.Number, entry.Kind, entry.Title, entry.Role);
        }
        foreach (var (file, why) in plan.Kept)
        {
            WriteRow(writer, Id(file), file.Path, file.Name, "", "", file.Title, why);
        }
    }

    /// <summary>The review's lists, into the plan's rules; a list not given says nothing.</summary>
    public static RenumberRules ReadRules(TextReader? vendors = null, TextReader? keep = null, TextReader? titles = null, TextReader? kinds = null)
    {
        var rules = new RenumberRules();
        foreach (var row in Rows(vendors).Where(r => r[0].Length > 0))
        {
            rules.Vendors.Add(VaultPaths.Key(row[0]));
        }
        foreach (var row in Rows(keep).Where(r => r[0].Length > 0))
        {
            rules.Keep.Add(VaultPaths.Key(row[0]));
        }
        foreach (var row in Rows(titles).Where(r => r.Length > 1 && r[0].Length > 0 && r[1].Trim().Length > 0))
        {
            rules.Titles[VaultPaths.Key(row[0])] = row[1].Trim();
        }
        foreach (var row in Rows(kinds).Where(r => r.Length > 2))
        {
            rules.FolderKinds[VaultPaths.Key(row[0].Trim('/'))] = (row[1].Trim(), row[2].Trim());
        }
        return rules;
    }

    /// <summary>A CSV file's rows, after its header: cells split at commas, quoted cells as Excel writes them.</summary>
    public static IEnumerable<string[]> Rows(TextReader? reader)
    {
        if (reader == null)
        {
            yield break;
        }
        var text = reader.ReadToEnd();
        var rows = new List<string[]>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < text.Length && text[i + 1] == '"')
                {
                    cell.Append('"');
                    i++;
                }
                else if (c == '"')
                {
                    quoted = false;
                }
                else
                {
                    cell.Append(c);
                }
            }
            else if (c == '"')
            {
                quoted = true;
            }
            else if (c == ',')
            {
                row.Add(cell.ToString());
                cell.Clear();
            }
            else if (c == '\n' || c == '\r')
            {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
                {
                    i++;
                }
                row.Add(cell.ToString());
                cell.Clear();
                rows.Add(row.ToArray());
                row.Clear();
            }
            else if (c != '﻿')
            {
                cell.Append(c);
            }
        }
        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            rows.Add(row.ToArray());
        }
        foreach (var each in rows.Skip(1).Where(r => r.Any(value => value.Length > 0)))
        {
            yield return each;
        }
    }

    public static void WriteRow(TextWriter writer, params string[] cells) =>
        writer.Write(string.Join(",", cells.Select(Quoted)) + "\r\n");

    // A cell as Excel writes one: in quotes, with its quotes doubled, if it has a comma, a quote, or a line break.
    private static string Quoted(string cell) =>
        cell.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0 ? cell : "\"" + cell.Replace("\"", "\"\"") + "\"";

    private static string Id(RenumberFile file) => file.Id.ToString(CultureInfo.InvariantCulture);
}
