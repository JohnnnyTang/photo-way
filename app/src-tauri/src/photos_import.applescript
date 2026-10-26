-- Arguments are passed as values by osascript, never interpolated into this script.
on dayFromISO(isoDay)
    set yy to (text 1 thru 4 of isoDay) as integer
    set mm to (text 6 thru 7 of isoDay) as integer
    set dd to (text 9 thru 10 of isoDay) as integer
    set monthNames to {January, February, March, April, May, June, July, August, September, October, November, December}
    set resultDay to current date
    set day of resultDay to 1
    set year of resultDay to yy
    set month of resultDay to item mm of monthNames
    set day of resultDay to dd
    set time of resultDay to 0
    return resultDay
end dayFromISO

on run argv
    set sourceMode to item 1 of argv
    set startText to item 2 of argv
    set endText to item 3 of argv
    set favoritesOnly to (item 4 of argv) is "true"
    set locationOnly to (item 5 of argv) is "true"
    set outputFolder to item 6 of argv
    set progressFile to item 7 of argv

    if sourceMode is "range" then
        set startDate to dayFromISO(startText)
        set endDate to (dayFromISO(endText) + days)
    end if

    tell application "Photos"
        with timeout of 7200 seconds
            if sourceMode is "selection" then
                set candidates to selection
            else
                set candidates to (get every media item whose date of it is greater than or equal to startDate and date of it is less than endDate)
            end if

            set chosen to {}
            repeat with photoItem in candidates
                set keepItem to true
                if favoritesOnly and not (favorite of photoItem) then set keepItem to false
                if locationOnly and keepItem then
                    set photoLocation to location of photoItem
                    if photoLocation is missing value then
                        set keepItem to false
                    else if (item 1 of photoLocation is missing value) or (item 2 of photoLocation is missing value) then
                        set keepItem to false
                    end if
                end if
                if keepItem then set end of chosen to contents of photoItem
            end repeat

            set totalCount to count of chosen
            do shell script "echo 0 " & totalCount & " > " & quoted form of progressFile
            set batchStart to 1
            repeat while batchStart <= totalCount
                set batchEnd to batchStart + 99
                if batchEnd > totalCount then set batchEnd to totalCount
                set batchFolder to outputFolder & "/batch-" & (batchStart as text)
                do shell script "mkdir -p " & quoted form of batchFolder
                set batchItems to items batchStart thru batchEnd of chosen
                export batchItems to (POSIX file batchFolder) with using originals
                do shell script "echo " & batchEnd & " " & totalCount & " > " & quoted form of progressFile
                set batchStart to batchEnd + 1
            end repeat
        end timeout
    end tell
    return totalCount as text
end run
